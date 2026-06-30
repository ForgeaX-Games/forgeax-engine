#include <napi.h>
#include <fbxsdk.h>
#include <sstream>
#include <string>
#include <vector>
#include <cmath>
#include <set>
#include <map>

// === Mesh attribute extraction helpers ===================================

/**
 * Extract per-control-point attributes from an FBX layer element.
 * Returns a vector of `floatCount` floats per control point.
 *
 * Handles eDirect (GetDirectArray) and eIndexToDirect (GetIndexArray ->
 * GetDirectArray) reference modes; mapping mode is assumed eByControlPoint.
 */
static std::vector<double> ExtractPerControlPoint(
    FbxLayerElementTemplate<FbxVector4>* elem, int controlPointsCount) {
  std::vector<double> out;
  out.reserve(controlPointsCount * 3);
  if (elem->GetReferenceMode() == FbxGeometryElement::eDirect) {
    for (int i = 0; i < controlPointsCount; i++) {
      FbxVector4 v = elem->GetDirectArray().GetAt(i);
      out.push_back(v[0]); out.push_back(v[1]); out.push_back(v[2]);
    }
  } else {
    for (int i = 0; i < controlPointsCount; i++) {
      int idx = elem->GetIndexArray().GetAt(i);
      FbxVector4 v = elem->GetDirectArray().GetAt(idx);
      out.push_back(v[0]); out.push_back(v[1]); out.push_back(v[2]);
    }
  }
  return out;
}

static std::vector<double> ExtractPerControlPointUV(
    FbxLayerElementTemplate<FbxVector2>* elem, int controlPointsCount) {
  std::vector<double> out;
  out.reserve(controlPointsCount * 2);
  if (elem->GetReferenceMode() == FbxGeometryElement::eDirect) {
    for (int i = 0; i < controlPointsCount; i++) {
      FbxVector2 v = elem->GetDirectArray().GetAt(i);
      out.push_back(v[0]); out.push_back(v[1]);
    }
  } else {
    for (int i = 0; i < controlPointsCount; i++) {
      int idx = elem->GetIndexArray().GetAt(i);
      FbxVector2 v = elem->GetDirectArray().GetAt(idx);
      out.push_back(v[0]); out.push_back(v[1]);
    }
  }
  return out;
}

/**
 * Extract per-polygon-vertex normals: for each polygon vertex, pull the
 * corresponding normal. Output array length = totalIndexCount * 3.
 */
static std::vector<double> ExtractPerPolygonVertexNormals(
    FbxMesh* mesh, int totalIndexCount) {
  FbxGeometryElementNormal* elem = mesh->GetElementNormal(0);
  std::vector<double> out;
  out.reserve(totalIndexCount * 3);

  const bool isDirect = (elem->GetReferenceMode() == FbxGeometryElement::eDirect);
  int idx = 0;
  for (int p = 0; p < mesh->GetPolygonCount(); p++) {
    int polySize = mesh->GetPolygonSize(p);
    for (int v = 0; v < polySize; v++) {
      FbxVector4 normal;
      if (isDirect) {
        normal = elem->GetDirectArray().GetAt(idx);
      } else {
        int mappedIdx = elem->GetIndexArray().GetAt(idx);
        normal = elem->GetDirectArray().GetAt(mappedIdx);
      }
      out.push_back(normal[0]); out.push_back(normal[1]); out.push_back(normal[2]);
      idx++;
    }
  }
  return out;
}

static std::vector<double> ExtractPerPolygonVertexUVs(
    FbxMesh* mesh, int totalIndexCount, int layerIndex) {
  FbxGeometryElementUV* elem = mesh->GetElementUV(layerIndex);
  std::vector<double> out;
  out.reserve(totalIndexCount * 2);

  const bool isDirect = (elem->GetReferenceMode() == FbxGeometryElement::eDirect);
  int idx = 0;
  for (int p = 0; p < mesh->GetPolygonCount(); p++) {
    int polySize = mesh->GetPolygonSize(p);
    for (int v = 0; v < polySize; v++) {
      FbxVector2 uv;
      if (isDirect) {
        uv = elem->GetDirectArray().GetAt(idx);
      } else {
        int mappedIdx = elem->GetIndexArray().GetAt(idx);
        uv = elem->GetDirectArray().GetAt(mappedIdx);
      }
      out.push_back(uv[0]); out.push_back(uv[1]);
      idx++;
    }
  }
  return out;
}

// === JSON helpers =========================================================

static void WriteFloatArray(std::ostringstream& json, const char* key,
                            const FbxVector4* arr, int count) {
  json << "\"" << key << "\":[";
  for (int i = 0; i < count; i++) {
    if (i > 0) json << ",";
    json << arr[i][0] << "," << arr[i][1] << "," << arr[i][2];
  }
  json << "]";
}

static void WriteDouble3Array(std::ostringstream& json, const char* key,
                              const std::vector<double>& arr) {
  json << "\"" << key << "\":[";
  for (size_t i = 0; i < arr.size(); i++) {
    if (i > 0) json << ",";
    double v = arr[i];
    if (std::isnan(v) || !std::isfinite(v)) v = 0.0;
    json << v;
  }
  json << "]";
}

static void WriteDouble2Array(std::ostringstream& json, const char* key,
                              const std::vector<double>& arr) {
  json << "\"" << key << "\":[";
  for (size_t i = 0; i < arr.size(); i++) {
    if (i > 0) json << ",";
    double v = arr[i];
    if (std::isnan(v) || !std::isfinite(v)) v = 0.0;
    json << v;
  }
  json << "]";
}

static void WriteIntArray(std::ostringstream& json, const char* key,
                          FbxMesh* mesh) {
  json << "\"" << key << "\":[";
  bool first = true;
  for (int p = 0; p < mesh->GetPolygonCount(); p++) {
    int polySize = mesh->GetPolygonSize(p);
    for (int v = 0; v < polySize; v++) {
      int index = mesh->GetPolygonVertex(p, v);
      if (!first) json << ",";
      first = false;
      json << index;
    }
  }
  json << "]";
}

// === Count total indices in a mesh ========================================

static int CountIndices(FbxMesh* mesh) {
  int total = 0;
  for (int p = 0; p < mesh->GetPolygonCount(); p++) {
    total += mesh->GetPolygonSize(p);
  }
  return total;
}

// === NURBS / patch detection (t46) ========================================

/**
 * Walk all nodes in the scene looking for NURBS or patch surfaces.
 * Returns the name of the first such mesh, or empty string if none found.
 */
static std::string FindNurbsMesh(FbxScene* scene) {
  FbxNode* root = scene->GetRootNode();
  if (!root) return "";

  std::vector<FbxNode*> queue;
  for (int i = 0; i < root->GetChildCount(); i++) {
    queue.push_back(root->GetChild(i));
  }
  for (size_t qi = 0; qi < queue.size(); qi++) {
    FbxNode* node = queue[qi];
    for (int i = 0; i < node->GetChildCount(); i++) {
      queue.push_back(node->GetChild(i));
    }
    FbxNodeAttribute* attr = node->GetNodeAttribute();
    if (!attr) continue;
    FbxGeometry* geom = FbxCast<FbxGeometry>(attr);
    if (!geom) continue;
    if (geom->GetAttributeType() == FbxNodeAttribute::eNurbs ||
        geom->GetAttributeType() == FbxNodeAttribute::eNurbsSurface ||
        geom->GetAttributeType() == FbxNodeAttribute::ePatch) {
      return node->GetName();
    }
  }
  return "";
}

// === Skeleton extraction (t45) ============================================

/**
 * Extract skeleton data from FBX scene: walk all nodes, collect FbxSkeleton
 * attribute nodes, compute inverse bind matrices from world transforms.
 *
 * For each skeleton node we record:
 *  - joint name (hierarchical path from root: "root/hip/knee")
 *  - inverse bind matrix (world transform inverse at bind pose, 16 floats)
 *
 * The FBX SDK doesn't directly expose pre-computed inverse bind matrices
 * for skeleton nodes (those come from FbxCluster in FbxSkin). Instead we
 * compute them from the world transform at bind pose (time=0).
 */
// Geometric offset of a node (FBX stores a per-node geometry transform that is
// NOT part of the scene-graph transform chain; skinned control points live in
// this geometry space).
static FbxAMatrix GeometryOffset(FbxNode* node) {
  const FbxVector4 t = node->GetGeometricTranslation(FbxNode::eSourcePivot);
  const FbxVector4 r = node->GetGeometricRotation(FbxNode::eSourcePivot);
  const FbxVector4 s = node->GetGeometricScaling(FbxNode::eSourcePivot);
  return FbxAMatrix(t, r, s);
}

// The inverse bind matrices MUST be derived from the FbxSkin clusters, in
// cluster order, so they (a) align 1:1 with the skin's per-vertex jointIndices
// and (b) use the real bind pose. The prior implementation inverted every
// FbxSkeleton node's global transform (wrong count: 80 skeleton nodes vs 60
// deforming clusters; wrong math: ignored the mesh transform + geometry offset),
// which scrambled the deformation. The standard formula per cluster is
//   IBM = transformLinkMatrix^-1 * transformMatrix * geometryOffset
// matching glTF's inverseBindMatrices semantics the runtime consumes.
static void WriteSkeletonData(FbxScene* scene, std::string& result) {
  FbxNode* root = scene->GetRootNode();
  if (!root) return;

  // Find the first skinned mesh's first FbxSkin (mirror of WriteSkinData's
  // BFS + "first skin per mesh" policy so joint order matches the skin block).
  std::vector<FbxNode*> queue;
  for (int i = 0; i < root->GetChildCount(); i++) queue.push_back(root->GetChild(i));
  FbxSkin* skin = nullptr;
  FbxNode* meshNode = nullptr;
  for (size_t qi = 0; qi < queue.size() && skin == nullptr; qi++) {
    FbxNode* node = queue[qi];
    for (int i = 0; i < node->GetChildCount(); i++) queue.push_back(node->GetChild(i));
    FbxMesh* mesh = node->GetMesh();
    if (!mesh) continue;
    for (int d = 0; d < mesh->GetDeformerCount(); d++) {
      FbxSkin* s = FbxCast<FbxSkin>(mesh->GetDeformer(d));
      if (s && s->GetClusterCount() > 0) {
        skin = s;
        meshNode = node;
        break;
      }
    }
  }

  if (skin == nullptr || meshNode == nullptr) return;

  const FbxAMatrix geometry = GeometryOffset(meshNode);
  const int clusterCount = skin->GetClusterCount();

  std::ostringstream json;
  json << ",\"skeletons\":[{";
  json << "\"jointCount\":" << clusterCount << ",";

  json << "\"inverseBindMatrices\":[";
  bool firstJoint = true;
  for (int c = 0; c < clusterCount; c++) {
    FbxCluster* cluster = skin->GetCluster(c);
    FbxAMatrix transformMatrix;      // mesh global transform at bind time
    FbxAMatrix transformLinkMatrix;  // joint global transform at bind time
    cluster->GetTransformMatrix(transformMatrix);
    cluster->GetTransformLinkMatrix(transformLinkMatrix);
    FbxAMatrix ibm = transformLinkMatrix.Inverse() * transformMatrix * geometry;
    if (!firstJoint) json << ",";
    firstJoint = false;
    for (int r = 0; r < 4; r++) {
      for (int col = 0; col < 4; col++) {
        if (r > 0 || col > 0) json << ",";
        json << ibm.Get(r, col);
      }
    }
  }
  json << "],";

  json << "\"jointPaths\":[";
  for (int c = 0; c < clusterCount; c++) {
    FbxCluster* cluster = skin->GetCluster(c);
    FbxNode* link = cluster->GetLink();
    if (c > 0) json << ",";
    json << "\"" << (link ? link->GetName() : "") << "\"";
  }
  json << "]";

  json << "}]";
  result += json.str();
}

// === Skin extraction (t45) ================================================

/**
 * Write skin data: per-mesh FbxSkin deformers, cluster weights, and
 * joint-to-skeleton mapping.
 */
static void WriteSkinData(FbxScene* scene, std::string& result) {
  FbxNode* root = scene->GetRootNode();
  if (!root) return;

  std::vector<std::string> skinBlocks;

  std::vector<FbxNode*> queue;
  for (int i = 0; i < root->GetChildCount(); i++) {
    queue.push_back(root->GetChild(i));
  }
  for (size_t qi = 0; qi < queue.size(); qi++) {
    FbxNode* node = queue[qi];
    for (int i = 0; i < node->GetChildCount(); i++) {
      queue.push_back(node->GetChild(i));
    }
    FbxMesh* mesh = node->GetMesh();
    if (!mesh) continue;

    int deformerCount = mesh->GetDeformerCount();
    for (int d = 0; d < deformerCount; d++) {
      FbxDeformer* deformer = mesh->GetDeformer(d);
      FbxSkin* skin = FbxCast<FbxSkin>(deformer);
      if (!skin) continue;

      int clusterCount = skin->GetClusterCount();
      if (clusterCount == 0) continue;

      // Collect joint names from clusters (in cluster order = joint order)
      std::vector<std::string> jointNames;
      for (int c = 0; c < clusterCount; c++) {
        FbxCluster* cluster = skin->GetCluster(c);
        if (!cluster) continue;
        FbxNode* link = cluster->GetLink();
        if (!link) continue;
        jointNames.push_back(link->GetName());
      }

      // Per-vertex influences: for each control point, collect up to 4
      // (jointIndex, weight) pairs from all clusters.
      int cpCount = mesh->GetControlPointsCount();
      std::ostringstream infJson;
      infJson << "[";
      bool firstInf = true;

      for (int cp = 0; cp < cpCount; cp++) {
        // Accumulate (jointIdx, weight) pairs for this vertex
        struct WeightPair { int jointIdx; double weight; };
        std::vector<WeightPair> pairs;

        for (int c = 0; c < clusterCount; c++) {
          FbxCluster* cluster = skin->GetCluster(c);
          if (!cluster) continue;
          int idxCount = cluster->GetControlPointIndicesCount();
          int* indices = cluster->GetControlPointIndices();
          double* weights = cluster->GetControlPointWeights();

          for (int k = 0; k < idxCount; k++) {
            if (indices[k] == cp) {
              pairs.push_back({c, weights[k]});
              break;
            }
          }
        }

        // Sort by weight descending, take top 4
        std::sort(pairs.begin(), pairs.end(),
                  [](const WeightPair& a, const WeightPair& b) { return a.weight > b.weight; });
        if (pairs.size() > 4) pairs.resize(4);

        // Normalize weights to sum to 1
        double sum = 0;
        for (auto& p : pairs) sum += p.weight;
        if (sum > 0) { for (auto& p : pairs) p.weight /= sum; }

        if (!firstInf) infJson << ",";
        firstInf = false;
        infJson << "{";
        infJson << "\"jointIndices\":[";
        for (size_t j = 0; j < 4; j++) {
          if (j > 0) infJson << ",";
          infJson << (j < pairs.size() ? pairs[j].jointIdx : 0);
        }
        infJson << "],";
        infJson << "\"jointWeights\":[";
        for (size_t j = 0; j < 4; j++) {
          if (j > 0) infJson << ",";
          infJson << (j < pairs.size() ? pairs[j].weight : 0.0);
        }
        infJson << "]";
        infJson << "}";
      }
      infJson << "]";

      std::ostringstream block;
      block << "{";
      block << "\"meshSourceIndex\":" << qi << ",";
      block << "\"jointPaths\":[";
      for (size_t j = 0; j < jointNames.size(); j++) {
        if (j > 0) block << ",";
        block << "\"" << jointNames[j] << "\"";
      }
      block << "],";
      block << "\"vertexCount\":" << cpCount << ",";
      block << "\"influences\":" << infJson.str();
      block << "}";

      skinBlocks.push_back(block.str());

      // Only first skin per mesh (OOS-4: single take)
      break;
    }
  }

  if (skinBlocks.empty()) return;

  std::ostringstream json;
  json << ",\"skins\":[";
  for (size_t s = 0; s < skinBlocks.size(); s++) {
    if (s > 0) json << ",";
    json << skinBlocks[s];
  }
  json << "]";
  result += json.str();
}

// === Animation extraction (t47) ===========================================

/**
 * Write animation clip data: iterate FbxAnimStack -> FbxAnimLayer -> nodes.
 *
 * For every key time on a node's LclTranslation / LclRotation / LclScaling
 * curves we re-sample node->EvaluateLocalTransform(t) and decompose to TRS
 * via GetT / GetQ / GetS -- the SAME authoritative path WalkNode uses for the
 * bind pose. Rotation is emitted as a real unit quaternion (x,y,z,w), NOT raw
 * euler-degree curve values; this lets the SDK resolve rotation order,
 * pre/post-rotation and pivot offsets instead of us reconstructing them.
 *
 * Output schema (flat per-channel timeline, one channel per animated TRS slot):
 *   { targetNode, property, keyTimes:[t...], keyValues:[...] }
 * keyValues stride is 3 for translation/scale, 4 for rotation (quat xyzw).
 * The TS bridge (parse-animation-clip.ts) merges + resamples to a fixed fps.
 */
static void WriteAnimationData(FbxScene* scene, std::string& result) {
  int animStackCount = scene->GetSrcObjectCount<FbxAnimStack>();
  if (animStackCount == 0) return;

  std::ostringstream clipsJson;
  int clipIdx = 0;

  for (int as = 0; as < animStackCount; as++) {
    FbxAnimStack* animStack = scene->GetSrcObject<FbxAnimStack>(as);
    if (!animStack) continue;

    int layerCount = animStack->GetMemberCount<FbxAnimLayer>();
    if (layerCount == 0) continue;

    // OOS-4: only the first take (anim stack base layer)
    FbxAnimLayer* layer = animStack->GetMember<FbxAnimLayer>(0);
    if (!layer) continue;

    // EvaluateLocalTransform(t) evaluates against the scene's CURRENT anim
    // stack; without this it returns the rest pose at every time (identity
    // animation). WalkNode gets away without it because rest pose == bind pose.
    scene->SetCurrentAnimationStack(animStack);

    FbxNode* root = scene->GetRootNode();
    if (!root) continue;

    // Build node path map (DFS) + flat node list.
    std::map<FbxNode*, std::string> nodePaths;
    std::vector<FbxNode*> allNodes;

    std::vector<FbxNode*> queue;
    for (int i = 0; i < root->GetChildCount(); i++) {
      FbxNode* child = root->GetChild(i);
      queue.push_back(child);
      nodePaths[child] = child->GetName();
      allNodes.push_back(child);
    }
    for (size_t qi = 0; qi < queue.size(); qi++) {
      FbxNode* node = queue[qi];
      for (int i = 0; i < node->GetChildCount(); i++) {
        FbxNode* child = node->GetChild(i);
        queue.push_back(child);
        nodePaths[child] = nodePaths[node] + "/" + child->GetName();
        allNodes.push_back(child);
      }
    }

    // Collect the union of every key time on a node's curve node into `out`
    // (seconds). Walks all curves under all destination properties so a
    // single-curve (dc=1) or per-axis (dc=3) rotation node both contribute.
    auto collectTimes = [](FbxAnimCurveNode* cn, std::set<double>& out) {
      if (!cn) return;
      int dc = cn->GetDstPropertyCount();
      for (int d = 0; d < dc; d++) {
        int chCount = cn->GetCurveCount(d);
        for (int ch = 0; ch < chCount; ch++) {
          FbxAnimCurve* curve = cn->GetCurve(d, ch);
          if (!curve) continue;
          int keyCount = curve->KeyGetCount();
          for (int k = 0; k < keyCount; k++) {
            out.insert(curve->KeyGetTime(k).GetSecondDouble());
          }
        }
      }
    };

    // Global time span (for clip duration).
    double minTime = 0.0, maxTime = 0.0;
    bool hasKeys = false;

    for (size_t ni = 0; ni < allNodes.size(); ni++) {
      FbxNode* node = allNodes[ni];
      std::set<double> times;
      collectTimes(node->LclTranslation.GetCurveNode(layer), times);
      collectTimes(node->LclRotation.GetCurveNode(layer), times);
      collectTimes(node->LclScaling.GetCurveNode(layer), times);
      if (times.empty()) continue;
      double lo = *times.begin();
      double hi = *times.rbegin();
      if (!hasKeys) {
        minTime = lo;
        maxTime = hi;
        hasKeys = true;
      } else {
        if (lo < minTime) minTime = lo;
        if (hi > maxTime) maxTime = hi;
      }
    }

    if (!hasKeys) continue;
    double duration = maxTime - minTime;
    if (duration <= 0) continue;

    if (clipIdx > 0) clipsJson << ",";
    clipsJson << "{";
    const char* stackName = animStack->GetName();
    clipsJson << "\"name\":\"" << (stackName ? stackName : "") << "\",";
    clipsJson << "\"duration\":" << duration << ",";
    clipsJson << "\"channels\":[";
    bool firstChannel = true;

    for (size_t ni = 0; ni < allNodes.size(); ni++) {
      FbxNode* node = allNodes[ni];
      FbxAnimCurveNode* cnT = node->LclTranslation.GetCurveNode(layer);
      FbxAnimCurveNode* cnR = node->LclRotation.GetCurveNode(layer);
      FbxAnimCurveNode* cnS = node->LclScaling.GetCurveNode(layer);

      // Per-property key-time sets. A property gets a channel only if it owns
      // animation curves (mirrors glTF: no channel for static slots).
      std::set<double> tT, tR, tS;
      collectTimes(cnT, tT);
      collectTimes(cnR, tR);
      collectTimes(cnS, tS);
      if (tT.empty() && tR.empty() && tS.empty()) continue;

      // Per-node sample timeline = union of all its animated properties, so a
      // single EvaluateLocalTransform(t) feeds every channel on this node.
      std::set<double> tAll;
      tAll.insert(tT.begin(), tT.end());
      tAll.insert(tR.begin(), tR.end());
      tAll.insert(tS.begin(), tS.end());
      std::vector<double> times(tAll.begin(), tAll.end());

      // Evaluate the SDK local transform once per key time, decompose to TRS.
      size_t n = times.size();
      std::vector<double> tx(n), ty(n), tz(n);
      std::vector<double> qx(n), qy(n), qz(n), qw(n);
      std::vector<double> sx(n), sy(n), sz(n);
      double pqx = 0, pqy = 0, pqz = 0, pqw = 1; // previous quat for sign fix
      for (size_t f = 0; f < n; f++) {
        FbxTime ft;
        ft.SetSecondDouble(times[f]);
        FbxAMatrix m = node->EvaluateLocalTransform(ft);
        FbxVector4 t = m.GetT();
        FbxQuaternion q = m.GetQ();
        FbxVector4 s = m.GetS();
        tx[f] = t[0]; ty[f] = t[1]; tz[f] = t[2];
        double cx = q[0], cy = q[1], cz = q[2], cw = q[3];
        // Canonicalize sign for short-arc continuity across adjacent keys
        // (EvaluateLocalTransform may flip the quaternion hemisphere).
        if (cx * pqx + cy * pqy + cz * pqz + cw * pqw < 0) {
          cx = -cx; cy = -cy; cz = -cz; cw = -cw;
        }
        qx[f] = pqx = cx; qy[f] = pqy = cy; qz[f] = pqz = cz; qw[f] = pqw = cw;
        sx[f] = s[0]; sy[f] = s[1]; sz[f] = s[2];
      }

      auto writeArr = [&](const std::vector<double>& v) {
        clipsJson << "[";
        for (size_t i = 0; i < v.size(); i++) {
          if (i > 0) clipsJson << ",";
          clipsJson << v[i];
        }
        clipsJson << "]";
      };
      auto writeTimes = [&]() {
        clipsJson << "[";
        for (size_t i = 0; i < times.size(); i++) {
          if (i > 0) clipsJson << ",";
          clipsJson << times[i];
        }
        clipsJson << "]";
      };
      auto interleave3 = [&](const std::vector<double>& a,
                             const std::vector<double>& b,
                             const std::vector<double>& c) {
        clipsJson << "[";
        for (size_t i = 0; i < a.size(); i++) {
          if (i > 0) clipsJson << ",";
          clipsJson << a[i] << "," << b[i] << "," << c[i];
        }
        clipsJson << "]";
      };
      auto interleave4 = [&](const std::vector<double>& a,
                             const std::vector<double>& b,
                             const std::vector<double>& c,
                             const std::vector<double>& d) {
        clipsJson << "[";
        for (size_t i = 0; i < a.size(); i++) {
          if (i > 0) clipsJson << ",";
          clipsJson << a[i] << "," << b[i] << "," << c[i] << "," << d[i];
        }
        clipsJson << "]";
      };
      (void)writeArr;

      auto emitChannel = [&](const char* propName, char kind) {
        if (!firstChannel) clipsJson << ",";
        firstChannel = false;
        clipsJson << "{";
        clipsJson << "\"targetNode\":\"" << nodePaths[node] << "\",";
        clipsJson << "\"property\":\"" << propName << "\",";
        clipsJson << "\"keyTimes\":";
        writeTimes();
        clipsJson << ",\"keyValues\":";
        if (kind == 'r') interleave4(qx, qy, qz, qw);
        else if (kind == 't') interleave3(tx, ty, tz);
        else interleave3(sx, sy, sz);
        clipsJson << "}";
      };

      if (!tT.empty()) emitChannel("translation", 't');
      if (!tR.empty()) emitChannel("rotation", 'r');
      if (!tS.empty()) emitChannel("scale", 's');
    }

    clipsJson << "]"; // channels
    clipsJson << "}";
    clipIdx++;
  }

  if (clipIdx == 0) return;

  std::ostringstream json;
  json << ",\"clips\":[" << clipsJson.str() << "]";
  result += json.str();
}

// === Mesh-to-JSON (t24 expanded) ==========================================

static std::string MeshToJson(FbxMesh* mesh, int sourceIndex) {
  std::ostringstream json;
  json << "{";

  // name
  FbxNode* node = mesh->GetNode();
  const char* name = node ? node->GetName() : "";
  json << "\"name\":\"" << name << "\",";

  // vertices (control points)
  int cpCount = mesh->GetControlPointsCount();
  FbxVector4* cp = mesh->GetControlPoints();
  WriteFloatArray(json, "vertices", cp, cpCount);
  json << ",";

  // indices
  WriteIntArray(json, "indices", mesh);
  json << ",";

  // attributes
  json << "\"attributes\":{";

  bool hasAttr = false;

  // NORMAL
  if (mesh->GetElementNormalCount() > 0) {
    FbxGeometryElementNormal* normalElem = mesh->GetElementNormal(0);
    if (normalElem->GetMappingMode() == FbxGeometryElement::eByControlPoint) {
      auto normals = ExtractPerControlPoint(
          reinterpret_cast<FbxLayerElementTemplate<FbxVector4>*>(normalElem), cpCount);
      WriteDouble3Array(json, "NORMAL", normals);
      hasAttr = true;
    } else {
      // eByPolygonVertex: expand to per-index normals
      int totalIdx = CountIndices(mesh);
      auto normals = ExtractPerPolygonVertexNormals(mesh, totalIdx);
      WriteDouble3Array(json, "NORMAL", normals);
      hasAttr = true;
    }
  }

  // TEXCOORD_0 (UV layer 0)
  if (mesh->GetElementUVCount() > 0) {
    if (hasAttr) json << ",";
    FbxGeometryElementUV* uvElem = mesh->GetElementUV(0);
    if (uvElem->GetMappingMode() == FbxGeometryElement::eByControlPoint) {
      auto uvs = ExtractPerControlPointUV(uvElem, cpCount);
      WriteDouble2Array(json, "TEXCOORD_0", uvs);
    } else {
      // eByPolygonVertex: expand to per-index UVs
      int totalIdx = CountIndices(mesh);
      auto uvs = ExtractPerPolygonVertexUVs(mesh, totalIdx, 0);
      WriteDouble2Array(json, "TEXCOORD_0", uvs);
    }
  }

  json << "},";

  // polygonCount
  json << "\"polygonCount\":" << mesh->GetPolygonCount() << ",";

  // sourceIndex
  json << "\"sourceIndex\":" << sourceIndex << ",";

  // materialIndex (single material per mesh in t24)
  int matCount = node ? node->GetMaterialCount() : 0;
  json << "\"materialIndex\":" << (matCount > 0 ? 0 : -1);

  json << "}";
  return json.str();
}

// === Walk scene tree (t25) ================================================

// Assign each node a flat-array index in DFS pre-order, identical to the order
// WalkNode emits nodes (the node itself, then each child subtree). children[]
// arrays reference these indices, so the map MUST be built with the same
// traversal or the reconstructed hierarchy is corrupt (the prior code used a
// running link counter, off-by-one against the emit order: every joint resolved
// to the wrong entity and skinned scenes failed skin-joint-path-unresolved).
static void BuildNodeIndexMap(FbxNode* node, std::map<FbxNode*, int>& nodeIndex,
                              int& counter) {
  nodeIndex[node] = counter++;
  for (int i = 0; i < node->GetChildCount(); i++) {
    BuildNodeIndexMap(node->GetChild(i), nodeIndex, counter);
  }
}

static void WalkNode(FbxNode* node, std::ostringstream& json,
                     int depth, bool& firstNode,
                     const std::map<FbxNode*, int>& nodeIndex) {
  if (firstNode) firstNode = false;
  else json << ",";

  json << "{";

  // name
  json << "\"name\":\"" << node->GetName() << "\",";

  // transform via EvaluateLocalTransform (Unity SWIG ground truth F-3)
  FbxTime time; // default time = 0
  FbxAMatrix localTransform = node->EvaluateLocalTransform(time);
  FbxVector4 t = localTransform.GetT();
  FbxQuaternion q = localTransform.GetQ();
  FbxVector4 s = localTransform.GetS();

  json << "\"transform\":{";
  json << "\"translation\":[" << t[0] << "," << t[1] << "," << t[2] << "],";
  json << "\"rotation\":[" << q[0] << "," << q[1] << "," << q[2] << "," << q[3] << "],";
  json << "\"scale\":[" << s[0] << "," << s[1] << "," << s[2] << "]";
  json << "},";

  // meshIndex (-1 if no mesh)
  FbxMesh* mesh = node->GetMesh();
  json << "\"meshIndex\":" << (mesh != nullptr ? 0 : -1) << ",";

  // children indices: resolved through the pre-built DFS index map so they
  // agree with the flat emit order.
  json << "\"children\":[";
  int childCount = node->GetChildCount();
  for (int i = 0; i < childCount; i++) {
    FbxNode* child = node->GetChild(i);
    auto it = nodeIndex.find(child);
    int childNodeIdx = it != nodeIndex.end() ? it->second : -1;
    if (i > 0) json << ",";
    json << childNodeIdx;
  }
  json << "]";
  json << "}";

  // Recurse into children
  for (int i = 0; i < childCount; i++) {
    WalkNode(node->GetChild(i), json, depth + 1, firstNode, nodeIndex);
  }
}

// === Scene-walk main ======================================================

static std::string SceneToJson(FbxScene* scene) {
  std::ostringstream json;
  json << "{";

  // Meshes array
  json << "\"meshes\":[";
  bool firstMesh = true;

  // Collect meshes from all nodes
  FbxNode* root = scene->GetRootNode();
  std::vector<FbxNode*> nodeQueue;
  if (root) {
    for (int i = 0; i < root->GetChildCount(); i++) {
      nodeQueue.push_back(root->GetChild(i));
    }
  }
  int meshIdx = 0;
  for (size_t qi = 0; qi < nodeQueue.size(); qi++) {
    FbxNode* node = nodeQueue[qi];
    // Enqueue children for future processing
    for (int i = 0; i < node->GetChildCount(); i++) {
      nodeQueue.push_back(node->GetChild(i));
    }
    FbxMesh* mesh = node->GetMesh();
    if (mesh) {
      if (!firstMesh) json << ",";
      firstMesh = false;
      json << MeshToJson(mesh, meshIdx++);
    }
  }
  json << "],";

  // Nodes array (flat tree). Pre-pass: assign DFS pre-order indices that match
  // WalkNode's emit order, so children[] references are correct.
  json << "\"nodes\":[";
  bool firstNode = true;
  std::map<FbxNode*, int> nodeIndex;
  if (root) {
    int counter = 0;
    for (int i = 0; i < root->GetChildCount(); i++) {
      BuildNodeIndexMap(root->GetChild(i), nodeIndex, counter);
    }
    for (int i = 0; i < root->GetChildCount(); i++) {
      WalkNode(root->GetChild(i), json, 0, firstNode, nodeIndex);
    }
  }
  json << "]";

  json << "}";
  return json.str();
}

// === Texture extraction (t26) ==============================================

/**
 * Collect textures connected to a specific material property channel.
 */
static void CollectTexturesForProperty(
    FbxSurfaceMaterial* mat, const char* propName,
    std::ostringstream& json, bool& firstTexture, int& texIdx,
    std::vector<std::string>& seenFiles) {
  FbxProperty prop = mat->FindProperty(propName);
  if (!prop.IsValid()) return;

  int texCount = prop.GetSrcObjectCount<FbxTexture>();
  for (int t = 0; t < texCount; t++) {
    FbxTexture* tex = prop.GetSrcObject<FbxTexture>(t);
    if (!tex) continue;

    FbxFileTexture* fileTex = FbxCast<FbxFileTexture>(tex);
    if (!fileTex) continue;

    const char* fileName = fileTex->GetFileName();
    if (!fileName || fileName[0] == '\0') continue;

    // Embedded media detection
    if (fileTex->GetUserDataPtr() != nullptr) {
      fprintf(stderr, "warn:embedded-media-not-supported, dropped: %s\n",
              fileTex->GetName());
      continue;
    }

    // Normalize path separators: backslash -> forward slash
    std::string path(fileName);
    for (size_t c = 0; c < path.size(); c++) {
      if (path[c] == '\\') path[c] = '/';
    }

    // Deduplicate by filename
    bool dup = false;
    for (const auto& seen : seenFiles) {
      if (seen == path) { dup = true; break; }
    }
    if (dup) continue;
    seenFiles.push_back(path);

    if (!firstTexture) json << ",";
    firstTexture = false;

    json << "{";
    json << "\"name\":\"" << fileTex->GetName() << "\",";
    json << "\"filePath\":\"" << path << "\",";
    json << "\"sourceIndex\":" << texIdx++;
    json << "}";
  }
}

// === StingrayPBS detection (t39) ============================================

/**
 * Walk a material's FbxImplementation nodes to detect StingrayPBS.
 * Unity FBX importer ground truth: checks if any implementation has
 * RenderAPI == "Stingray". Our heuristic also checks the RenderName
 * for "ASMShaderUniqueID_StingrayPBS" as secondary signal.
 */
static bool IsStingrayPBS(FbxSurfaceMaterial* mat) {
  int implCount = mat->GetImplementationCount();
  for (int i = 0; i < implCount; i++) {
    const FbxImplementation* impl = mat->GetImplementation(i);
    if (!impl) continue;

    FbxString renderAPI = impl->RenderAPI.Get();
    if (renderAPI == "Stingray") return true;

    // Secondary: RenderName carries the unique shader ID
    if (strstr(impl->RenderName.Buffer(), "StingrayPBS") != nullptr) return true;
  }
  return false;
}

/**
 * Extract a single float property value from the material.
 * Returns defaultValue if the property is not found or invalid.
 */
static double MaterialPropertyDouble(FbxSurfaceMaterial* mat,
                                     const char* propName,
                                     double defaultVal = 0.0) {
  FbxProperty prop = mat->FindProperty(propName);
  if (!prop.IsValid()) return defaultVal;
  return prop.Get<FbxDouble>();
}

/**
 * Extract a FbxDouble3 property as [r,g,b] values.
 */
static void WriteDouble3(std::ostringstream& json,
                         FbxSurfaceMaterial* mat,
                         const char* propName) {
  FbxProperty prop = mat->FindProperty(propName);
  if (!prop.IsValid()) {
    json << "[0.5,0.5,0.5]";
    return;
  }
  FbxDouble3 v = prop.Get<FbxDouble3>();
  json << "[" << v[0] << "," << v[1] << "," << v[2] << "]";
}

// === Material extraction (t39) =============================================

/**
 * Write all materials found across the scene as a JSON array.
 * Detection priority: StingrayPBS > Phong > Lambert > fallback.
 */
static void WriteMaterials(FbxScene* scene, std::ostringstream& json,
                           bool& firstMaterial) {
  FbxNode* root = scene->GetRootNode();
  if (!root) return;

  std::vector<FbxNode*> nodeQueue;
  for (int i = 0; i < root->GetChildCount(); i++) {
    nodeQueue.push_back(root->GetChild(i));
  }

  // Enqueue all children for BFS
  for (size_t qi = 0; qi < nodeQueue.size(); qi++) {
    FbxNode* node = nodeQueue[qi];
    for (int i = 0; i < node->GetChildCount(); i++) {
      nodeQueue.push_back(node->GetChild(i));
    }
  }

  // Deduplicate materials by name (single scene: name is stable)
  std::set<std::string> seenNames;

  for (size_t qi = 0; qi < nodeQueue.size(); qi++) {
    FbxNode* node = nodeQueue[qi];
    int matCount = node->GetMaterialCount();
    for (int m = 0; m < matCount; m++) {
      FbxSurfaceMaterial* mat = node->GetMaterial(m);
      if (!mat) continue;

      const char* matName = mat->GetName();
      if (!matName || matName[0] == '\0') continue;

      std::string name(matName);
      if (seenNames.count(name)) continue;
      seenNames.insert(name);

      if (!firstMaterial) json << ",";
      firstMaterial = false;

      json << "{";
      json << "\"name\":\"" << name << "\",";

      // --- type detection ---
      if (IsStingrayPBS(mat)) {
        json << "\"kind\":\"stingray-pbs\",";

        // StingrayPBS: extract Maya|property channels
        json << "\"stingrayProps\":{";
        FbxProperty bcProp = mat->FindProperty("Maya|base_color");
        if (bcProp.IsValid()) {
          FbxDouble3 v = bcProp.Get<FbxDouble3>();
          json << "\"baseColor\":[" << v[0] << "," << v[1] << "," << v[2] << "],";
        }
        FbxProperty metProp = mat->FindProperty("Maya|metallic");
        if (metProp.IsValid()) {
          json << "\"metallic\":" << metProp.Get<FbxDouble>() << ",";
        }
        FbxProperty roughProp = mat->FindProperty("Maya|roughness");
        if (roughProp.IsValid()) {
          json << "\"roughness\":" << roughProp.Get<FbxDouble>() << ",";
        }
        FbxProperty emProp = mat->FindProperty("Maya|emissive");
        if (emProp.IsValid()) {
          FbxDouble3 v = emProp.Get<FbxDouble3>();
          json << "\"emissive\":[" << v[0] << "," << v[1] << "," << v[2] << "]";
        }
        json << "}";

      } else if (mat->Is<FbxSurfacePhong>()) {
        json << "\"kind\":\"phong\",";

        FbxSurfacePhong* phong = FbxCast<FbxSurfacePhong>(mat);
        // Diffuse
        json << "\"diffuse\":";
        WriteDouble3(json, mat, FbxSurfaceMaterial::sDiffuse);
        json << ",";
        // Shininess (specular exponent)
        double shininess = MaterialPropertyDouble(mat, FbxSurfaceMaterial::sShininess, 100.0);
        json << "\"shininess\":" << shininess;
        // Specular
        if (phong) {
          FbxDouble3 spec = phong->Specular.Get();
          if (spec[0] != 0 || spec[1] != 0 || spec[2] != 0) {
            json << ",\"specular\":[" << spec[0] << "," << spec[1] << "," << spec[2] << "]";
          }
        }

      } else if (mat->Is<FbxSurfaceLambert>()) {
        json << "\"kind\":\"lambert\",";
        json << "\"diffuse\":";
        WriteDouble3(json, mat, FbxSurfaceMaterial::sDiffuse);

      } else {
        // Unrecognized type: fallback
        json << "\"kind\":\"fallback\"";
      }

      json << ",\"sourceIndex\":" << seenNames.size();
      json << "}";
    }
  }
}

/**
 * Write all textures found across materials in the scene.
 */
static void WriteTextures(FbxScene* scene, std::ostringstream& json,
                          bool& firstTexture, int& texIdx) {
  FbxNode* root = scene->GetRootNode();
  if (!root) return;

  std::vector<FbxNode*> nodeQueue;
  for (int i = 0; i < root->GetChildCount(); i++) {
    nodeQueue.push_back(root->GetChild(i));
  }

  std::vector<std::string> seenFiles;

  // Well-known material property channels that carry textures
  // (feat-20260615-fbx-importer-via-sdk M3: M4 will expand to normal/roughness/etc.)
  static const char* kTextureProps[] = {
    FbxSurfaceMaterial::sDiffuse,
    FbxSurfaceMaterial::sDiffuseFactor,
    FbxSurfaceMaterial::sBump,
    FbxSurfaceMaterial::sNormalMap,
    FbxSurfaceMaterial::sSpecular,
    FbxSurfaceMaterial::sEmissive,
    // StingrayPBS channels (M4)
    "Maya|base_color",
    "Maya|normal",
    "Maya|metallic",
    "Maya|roughness",
    "Maya|emissive",
  };

  for (size_t qi = 0; qi < nodeQueue.size(); qi++) {
    FbxNode* node = nodeQueue[qi];
    for (int i = 0; i < node->GetChildCount(); i++) {
      nodeQueue.push_back(node->GetChild(i));
    }

    int matCount = node->GetMaterialCount();
    for (int m = 0; m < matCount; m++) {
      FbxSurfaceMaterial* mat = node->GetMaterial(m);
      if (!mat) continue;

      for (const char* propName : kTextureProps) {
        CollectTexturesForProperty(mat, propName, json, firstTexture, texIdx, seenFiles);
      }
    }
  }
}

// === Main parse entry =====================================================

Napi::Value ParseFbx(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected filename string").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string filename = info[0].As<Napi::String>().Utf8Value();

  FbxManager* manager = FbxManager::Create();
  if (!manager) {
    Napi::Error::New(env, "Failed to create FbxManager").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  FbxIOSettings* ios = FbxIOSettings::Create(manager, IOSROOT);
  manager->SetIOSettings(ios);

  FbxImporter* importer = FbxImporter::Create(manager, "");
  if (!importer->Initialize(filename.c_str(), -1, manager->GetIOSettings())) {
    std::string err = "Failed to import: ";
    err += importer->GetStatus().GetErrorString();
    importer->Destroy();
    manager->Destroy();
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  FbxScene* scene = FbxScene::Create(manager, "scene");
  if (!importer->Import(scene)) {
    std::string err = "Failed to import scene: ";
    err += importer->GetStatus().GetErrorString();
    importer->Destroy();
    manager->Destroy();
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  importer->Destroy();

  // t46: NURBS / patch fail-fast BEFORE any scene processing.
  // Fail the entire import if any mesh is NURBS or patch (charter P3).
  std::string nurbsName = FindNurbsMesh(scene);
  if (!nurbsName.empty()) {
    std::ostringstream nurbsErr;
    nurbsErr << "{\"error\":{\"code\":\"fbx-mesh-type-unsupported\","
             << "\"meshType\":\"nurbs\","
             << "\"meshName\":\"" << nurbsName << "\"}}";
    manager->Destroy();
    return Napi::String::New(env, nurbsErr.str());
  }

  // t27: Convert to OpenGL (Y-up RH) coordinate system
  // Must execute BEFORE any mesh/node walk.
  FbxAxisSystem openglSystem(FbxAxisSystem::eYAxis, FbxAxisSystem::eParityOdd, FbxAxisSystem::eRightHanded);
  openglSystem.ConvertScene(scene);

  std::string result;

  try {
    result = SceneToJson(scene);

    // t39: Extract materials; t26: Extract textures
    // t45: Extract skeleton + skin; t47: Extract animation
    // Append all as top-level arrays before the closing "}" of the scene JSON
    if (result.size() > 1 && result[result.size() - 1] == '}') {
      result.resize(result.size() - 1); // Remove closing "}"

      // Materials
      bool firstMaterial = true;
      std::ostringstream matJson;
      WriteMaterials(scene, matJson, firstMaterial);
      std::string matStr = matJson.str();
      if (!matStr.empty()) {
        result += ",\"materials\":[" + matStr + "]";
      }

      // Textures
      std::ostringstream texJson;
      bool firstTexture = true;
      int texIdx = 0;
      WriteTextures(scene, texJson, firstTexture, texIdx);
      std::string texStr = texJson.str();
      if (!texStr.empty()) {
        result += ",\"textures\":[" + texStr + "]";
      }

      // t45: Skeleton data
      WriteSkeletonData(scene, result);

      // t45: Skin data
      WriteSkinData(scene, result);

      // t47: Animation clip data
      WriteAnimationData(scene, result);

      result += "}"; // Restore closing brace
    }
  } catch (const std::exception& e) {
    manager->Destroy();
    Napi::Error::New(env, std::string("FBX parse error: ") + e.what())
        .ThrowAsJavaScriptException();
    return env.Undefined();
  } catch (...) {
    manager->Destroy();
    Napi::Error::New(env, "Unknown FBX parse error").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  manager->Destroy();
  return Napi::String::New(env, result);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("parseFbx", Napi::Function::New(env, ParseFbx));
  return exports;
}

NODE_API_MODULE(fbx_binding, Init)