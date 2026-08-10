import { describe, expect, it } from 'vitest';
import { Disabled, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import {
  BouncyBallHazard,
  COUNTERATTACK_PRESSURE_TABLE,
  DamageHazard,
  PlayerHealth,
  createCounterattack,
  deriveCounterattackPressure,
  resolveCounterattackContact,
} from '../assets/plugins/counterattack.js';

describe('game-default counterattack pressure', () => {
  it('derives four bounded tiers only from collected EnergyCores', () => {
    expect(deriveCounterattackPressure(-1)).toEqual({
      tier: 0,
      ...COUNTERATTACK_PRESSURE_TABLE[0],
    });
    for (let tier = 0; tier < COUNTERATTACK_PRESSURE_TABLE.length; tier++) {
      expect(deriveCounterattackPressure(tier)).toEqual({
        tier,
        ...COUNTERATTACK_PRESSURE_TABLE[tier],
      });
    }
    expect(deriveCounterattackPressure(99)).toEqual({
      tier: 3,
      ...COUNTERATTACK_PRESSURE_TABLE[3],
    });
  });

  it('keeps baseline motion and raises every pressure dimension monotonically within the chase cap', () => {
    expect(COUNTERATTACK_PRESSURE_TABLE[0]).toEqual({
      patrolSpeed: 1.3,
      chaseSpeed: 2.15,
      pursuitRadius: 10,
    });
    for (let tier = 1; tier < COUNTERATTACK_PRESSURE_TABLE.length; tier++) {
      const previous = COUNTERATTACK_PRESSURE_TABLE[tier - 1];
      const current = COUNTERATTACK_PRESSURE_TABLE[tier];
      expect(current?.patrolSpeed).toBeGreaterThan(previous?.patrolSpeed ?? Number.POSITIVE_INFINITY);
      expect(current?.chaseSpeed).toBeGreaterThan(previous?.chaseSpeed ?? Number.POSITIVE_INFINITY);
      expect(current?.pursuitRadius).toBeGreaterThan(previous?.pursuitRadius ?? Number.POSITIVE_INFINITY);
    }
    expect(COUNTERATTACK_PRESSURE_TABLE[3].chaseSpeed)
      .toBeLessThanOrEqual(COUNTERATTACK_PRESSURE_TABLE[0].chaseSpeed * 1.5);
  });
});

describe('game-default counterattack damage', () => {
  it('restores the authored active hazard and exact transient fields on Reset', () => {
    const world = new World();
    const player = world.spawn(
      { component: PlayerHealth, data: { current: 1, max: 3 } },
      { component: Transform, data: { pos: [0, 0.75, 0] } },
    ).unwrap();
    const hazard = world.spawn(
      { component: BouncyBallHazard, data: { mode: 1, patrolAngle: 2 } },
      { component: DamageHazard, data: { cooldown: 0.7, acceptedHits: 2 } },
      { component: Transform, data: { pos: [-5, 0.55, 4] } },
      { component: Disabled, data: {} },
    ).unwrap();

    const counterattack = createCounterattack(world, player, () => 0);

    expect(world.get(hazard, Disabled).ok).toBe(false);
    expect(world.get(hazard, BouncyBallHazard).unwrap()).toEqual({
      mode: 0,
      patrolAngle: 0,
    });
    expect(world.get(hazard, DamageHazard).unwrap()).toEqual({
      cooldown: 0,
      acceptedHits: 0,
    });
    expect(world.get(player, PlayerHealth).unwrap()).toEqual({ current: 3, max: 3 });
    expect(counterattack.snapshot()).toMatchObject({
      hazardActive: true,
      hazardMode: 'patrol',
      pressureTier: 0,
    });
  });

  it('removes exactly one heart for an admitted contact', () => {
    expect(resolveCounterattackContact({ health: 3, cooldown: 0 })).toEqual({
      health: 2,
      cooldown: 1.2,
      admitted: true,
      defeated: false,
      shieldConsumed: false,
    });
  });

  it('suppresses repeated contact during the attacker cooldown', () => {
    expect(resolveCounterattackContact({ health: 2, cooldown: 0.4 })).toEqual({
      health: 2,
      cooldown: 0.4,
      admitted: false,
      defeated: false,
      shieldConsumed: false,
    });
  });

  it('requests defeat only when the last heart is removed', () => {
    expect(resolveCounterattackContact({ health: 1, cooldown: 0 })).toEqual({
      health: 0,
      cooldown: 1.2,
      admitted: true,
      defeated: true,
      shieldConsumed: false,
    });
  });
});
