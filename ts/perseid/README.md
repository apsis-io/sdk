# @apsis-io/perseid

The Perseid vocabulary for TypeScript guests - the ts half of the
[`apsis-perseid`](../../rust/perseid) crate's vocabulary.

What lives here:

- the ADR-0075 step contract (`perseid.ts`): a step is a generator that YIELDS
  effects and returns an Outcome - no I/O, replayable, where/reader/held/woke
  dispatch included
- the aperture expression language (`expr.ts`)
- resume conditions (`resume.ts`), field paths (`field.ts`), k8s projections
  (`k8s.ts`, `collection.ts`)
- runtime invariants backed by TypeBox (`invariant.ts`,
  `invariant-composition.ts`)
- backstop (`backstop.ts`) and wake (`wake.ts`) - the trail-runtime park
  contract
- the Perseid manifest (`manifest.ts`): `perseid()` builds and validates one,
  `toYaml()` renders it for `kubectl apply` - the manifest carries only the
  code; admission derives capabilities and writes from the step

Namespaced for the registry, direct for the importer - the same split
`apsis-perseid`'s Cargo.toml records. There is no barrel: import the specific
module you need (`@apsis-io/perseid/perseid.js`), and importing this package
obliges no `periapsis:*` interface in your world.wit - a step's effects are
data it yields, and the host supplies the world.

Apache-2.0, like the crate: this is the GUEST side - what a program links
against to run on Periapsis.

Extracted from `ts/periapsis` on 2026-10-06.

```
bun install && bun test
```
