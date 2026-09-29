export const OCCLUSION_QUERY_PAGE_COUNT = 3;
export const OCCLUSION_QUERY_PAGE_INDEX_LIMIT = 4096;
export const OCCLUSION_QUERY_RESULT_BYTES = 8;
export const OCCLUSION_QUERY_PAGE_BYTES =
  OCCLUSION_QUERY_PAGE_INDEX_LIMIT * OCCLUSION_QUERY_RESULT_BYTES;

export interface OcclusionQueryIdentity {
  readonly viewKey: string;
  readonly attachmentId: string;
  readonly deviceGeneration: number;
  readonly worldGeneration: number;
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
}

export interface OcclusionQueryReservation extends OcclusionQueryIdentity {
  readonly pageIndex: number;
  readonly queryIndex: number;
  readonly reservationId: number;
}

export interface OcclusionQueryTicket extends OcclusionQueryIdentity {
  readonly pageIndex: number;
  readonly queryIndex: number;
  readonly reservationId: number;
  readonly submissionGeneration: number;
}

export interface OcclusionQueryPoolInspection {
  readonly pageCount: number;
  readonly pageIndexLimit: number;
  readonly resolveBytes: number;
  readonly stagingBytes: number;
  readonly availablePages: number;
  readonly inFlight: number;
  readonly disposed: boolean;
}

export interface OcclusionQueryCompletion {
  readonly status: 'accepted' | 'stale';
  /** M3 transport never suppresses a draw; M4 owns confidence policy. */
  readonly visible: true;
}

interface PageState {
  readonly index: number;
  nextQueryIndex: number;
  pendingCount: number;
  inFlightCount: number;
}

function identityKey(identity: OcclusionQueryIdentity): string {
  return [
    identity.viewKey,
    identity.attachmentId,
    identity.deviceGeneration,
    identity.worldGeneration,
    identity.primitiveSlot,
    identity.slotGeneration,
  ].join('|');
}

/** Renderer-owned bounded query transport; it contains no visibility policy. */
export class OcclusionQueryPool {
  private readonly pages: PageState[] = Array.from(
    { length: OCCLUSION_QUERY_PAGE_COUNT },
    (_, index) => ({ index, nextQueryIndex: 0, pendingCount: 0, inFlightCount: 0 }),
  );
  private readonly pending = new Map<number, OcclusionQueryReservation>();
  private readonly tickets = new Map<number, OcclusionQueryTicket>();
  private nextReservationId = 1;
  private disposed = false;

  reserve(identity: OcclusionQueryIdentity): OcclusionQueryReservation | undefined {
    if (this.disposed) return undefined;
    const page = this.pages.find(
      (candidate) =>
        candidate.inFlightCount === 0 &&
        candidate.nextQueryIndex < OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
    );
    if (page === undefined || page.nextQueryIndex >= OCCLUSION_QUERY_PAGE_INDEX_LIMIT) {
      return undefined;
    }
    const reservation = Object.freeze({
      ...identity,
      pageIndex: page.index,
      queryIndex: page.nextQueryIndex,
      reservationId: this.nextReservationId++,
    });
    page.nextQueryIndex += 1;
    page.pendingCount += 1;
    this.pending.set(reservation.reservationId, reservation);
    return reservation;
  }

  publish(
    reservation: OcclusionQueryReservation,
    result: { readonly submitted: boolean; readonly submissionGeneration: number },
  ): OcclusionQueryTicket | undefined {
    const pending = this.pending.get(reservation.reservationId);
    if (pending === undefined || this.disposed) {
      return undefined;
    }
    // A failed shared submit leaves the reservation retryable but does not
    // count as in-flight work and never publishes a completion ticket.
    if (!result.submitted) return undefined;
    this.pending.delete(reservation.reservationId);
    const page = this.pages[pending.pageIndex];
    if (page !== undefined) {
      page.pendingCount = Math.max(0, page.pendingCount - 1);
      page.inFlightCount += 1;
    }
    const ticket = Object.freeze({ ...pending, submissionGeneration: result.submissionGeneration });
    this.tickets.set(ticket.reservationId, ticket);
    return ticket;
  }

  /** Return an unsubmitted reservation to its bounded page. */
  cancel(reservation: OcclusionQueryReservation): boolean {
    const pending = this.pending.get(reservation.reservationId);
    if (pending === undefined) return false;
    this.pending.delete(reservation.reservationId);
    const page = this.pages[pending.pageIndex];
    if (page !== undefined) {
      page.pendingCount = Math.max(0, page.pendingCount - 1);
      this.releasePage(pending.pageIndex);
    }
    return true;
  }

  complete(ticket: OcclusionQueryTicket, _samples: number): OcclusionQueryCompletion {
    const current = this.tickets.get(ticket.reservationId);
    if (current !== undefined) {
      this.tickets.delete(ticket.reservationId);
      const page = this.pages[current.pageIndex];
      if (page !== undefined) page.inFlightCount = Math.max(0, page.inFlightCount - 1);
      this.releasePage(current.pageIndex);
    }
    if (this.disposed || current === undefined || identityKey(current) !== identityKey(ticket)) {
      return { status: 'stale', visible: true };
    }
    return { status: 'accepted', visible: true };
  }

  inspect(): OcclusionQueryPoolInspection {
    return {
      pageCount: OCCLUSION_QUERY_PAGE_COUNT,
      pageIndexLimit: OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
      resolveBytes: OCCLUSION_QUERY_PAGE_BYTES,
      stagingBytes: OCCLUSION_QUERY_PAGE_BYTES,
      availablePages: this.disposed
        ? 0
        : this.pages.filter(
            (page) =>
              page.inFlightCount === 0 && page.nextQueryIndex < OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
          ).length,
      inFlight: this.tickets.size,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.tickets.clear();
    for (const page of this.pages) {
      page.pendingCount = 0;
      page.inFlightCount = 0;
    }
  }

  private releasePage(pageIndex: number): void {
    const page = this.pages[pageIndex];
    if (page !== undefined && page.pendingCount === 0 && page.inFlightCount === 0) {
      page.nextQueryIndex = 0;
    }
  }
}
