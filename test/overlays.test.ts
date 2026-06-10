// Loose TDD for the overlay recover-original core. Run with:
//   ./node_modules/.bin/esbuild test/overlays.test.ts --bundle --platform=node | node
// (or `npm test`). No framework — runtime asserts, non-zero exit on failure.
import {
  recordOriginal,
  forgetOriginal,
  isOverlaid,
  applyOriginals,
  type Originals
} from '../src/overlays'

let failures = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log('  ok:', msg)
  } else {
    console.error('  FAIL:', msg)
    failures++
  }
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// 1. record a present original; applyOriginals restores it over the overlaid live value.
{
  const originals: Originals = new Map()
  const scene = { '512': { GltfContainer: { src: 'a.glb', visibleMeshesCollisionMask: 0 } } }
  recordOriginal(originals, '512', 'GltfContainer', scene)
  const live = { '512': { GltfContainer: { src: 'a.glb', visibleMeshesCollisionMask: 256 } } }
  const logical = applyOriginals(originals, live)
  check(
    eq(logical['512'].GltfContainer, { src: 'a.glb', visibleMeshesCollisionMask: 0 }),
    'present original is restored over the overlaid value'
  )
  check(isOverlaid(originals, '512', 'GltfContainer'), 'isOverlaid true after record')
}

// 2. recordOriginal is idempotent — a second record keeps the true (first) original.
{
  const originals: Originals = new Map()
  const scene = { '1': { Visibility: { visible: true } } }
  recordOriginal(originals, '1', 'Visibility', scene)
  // overlay applied; the live snapshot now shows the overlaid value — re-record must NOT capture it
  const overlaid = { '1': { Visibility: { visible: false } } }
  recordOriginal(originals, '1', 'Visibility', overlaid)
  const logical = applyOriginals(originals, overlaid)
  check(eq(logical['1'].Visibility, { visible: true }), 'second record keeps the true original')
}

// 3. absent original: an overlay that ADDED a component is removed on recovery.
{
  const originals: Originals = new Map()
  const scene = { '7': { Transform: { position: { x: 0 } } } } // no MeshCollider
  recordOriginal(originals, '7', 'MeshCollider', scene)
  const live = { '7': { Transform: { position: { x: 0 } }, MeshCollider: { collisionMask: 256 } } }
  const logical = applyOriginals(originals, live)
  check(!('MeshCollider' in logical['7']), 'absent original drops the added component')
  check('Transform' in logical['7'], 'other components on the entity are untouched')
}

// 4. forgetOriginal: after clearing, the live (overlaid) value passes through unchanged.
{
  const originals: Originals = new Map()
  const scene = { '3': { Visibility: { visible: true } } }
  recordOriginal(originals, '3', 'Visibility', scene)
  forgetOriginal(originals, '3', 'Visibility')
  check(!isOverlaid(originals, '3', 'Visibility'), 'isOverlaid false after forget')
  const live = { '3': { Visibility: { visible: false } } }
  check(eq(applyOriginals(originals, live)['3'].Visibility, { visible: false }), 'live value passes through after forget')
  check(originals.size === 0, 'empty per-entity map is pruned')
}

// 5. applyOriginals does not mutate its input.
{
  const originals: Originals = new Map()
  const scene = { '9': { A: { v: 1 } } }
  recordOriginal(originals, '9', 'A', scene)
  const live = { '9': { A: { v: 2 } } }
  const snapshotBefore = JSON.stringify(live)
  applyOriginals(originals, live)
  check(JSON.stringify(live) === snapshotBefore, 'input snapshot is not mutated')
}

// 6. entities without overlays pass through; empty store returns the same snapshot reference.
{
  const originals: Originals = new Map()
  const live = { '1': { A: {} }, '2': { B: {} } }
  check(applyOriginals(originals, live) === live, 'empty store returns the same snapshot (identity)')
  recordOriginal(originals, '1', 'A', { '1': { A: { v: 0 } } })
  const logical = applyOriginals(originals, live)
  check(logical['2'] === live['2'], 'un-overlaid entity is shared by reference')
}

// 7. recovery on a deleted entity reintroduces only present originals (not an empty record).
{
  const originals: Originals = new Map()
  recordOriginal(originals, '5', 'Visibility', { '5': { Visibility: { visible: true } } })
  recordOriginal(originals, '5', 'MeshCollider', { '5': {} }) // absent
  const live = {} // entity gone
  const logical = applyOriginals(originals, live)
  check(eq(logical['5'], { Visibility: { visible: true } }), 'deleted entity recovers present originals only')
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall overlay tests passed')
