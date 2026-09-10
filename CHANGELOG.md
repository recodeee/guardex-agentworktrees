# Changelog

## [8.5.0](https://github.com/opencue/gitguardex/compare/v8.4.0...v8.5.0) (2026-09-10)


### Features

* **toolchain:** wire CodeGraph and OpenSrc by default ([#762](https://github.com/opencue/gitguardex/issues/762)) ([9125fb3](https://github.com/opencue/gitguardex/commit/9125fb356c950e34459dba6501817b9ab0a7f0da))


### Bug Fixes

* preserve reviewed revision through gated finish ([#772](https://github.com/opencue/gitguardex/issues/772)) ([46d5af9](https://github.com/opencue/gitguardex/commit/46d5af9f826725790ee9a78ffb0e5abef4a77344))

## [8.4.0](https://github.com/opencue/gitguardex/compare/v8.3.0...v8.4.0) (2026-09-01)


### Features

* **agents:** message agents with or without Nodeterm ([#765](https://github.com/opencue/gitguardex/issues/765)) ([125a90a](https://github.com/opencue/gitguardex/commit/125a90aae959338da526930a2ac04969e0c1659b))
* **vscode:** expose managed worktrees as visible repositories ([#763](https://github.com/opencue/gitguardex/issues/763)) ([915baf0](https://github.com/opencue/gitguardex/commit/915baf0e6f4dbb86cd11011f549e9d55eb6cf659))


### Bug Fixes

* **cleanup:** recover stale Codex worktrees before lane start ([#764](https://github.com/opencue/gitguardex/issues/764)) ([378394f](https://github.com/opencue/gitguardex/commit/378394f58f0b9edb4e99281fd9c59783b421d69c))

## [8.3.0](https://github.com/opencue/gitguardex/compare/v8.2.0...v8.3.0) (2026-08-31)


### Features

* allow adaptive direct-main agent work ([#731](https://github.com/opencue/gitguardex/issues/731)) ([4e84233](https://github.com/opencue/gitguardex/commit/4e842332e8b77779c9c814b66580ee972a7e8f48))
* **sync:** target agent branches by name ([#736](https://github.com/opencue/gitguardex/issues/736)) ([6bc587b](https://github.com/opencue/gitguardex/commit/6bc587b9504c09f0772697b27f11e1ad418a5072))


### Bug Fixes

* **branch:** persist explicit finish bases ([#750](https://github.com/opencue/gitguardex/issues/750)) ([1764b82](https://github.com/opencue/gitguardex/commit/1764b8242458ba7b44b7569d637a10b489d7058f))
* **branch:** validate bases before metadata repair ([#751](https://github.com/opencue/gitguardex/issues/751)) ([0a48ab2](https://github.com/opencue/gitguardex/commit/0a48ab2dab917482324ef79f3de59683922acf27))
* **cleanup:** close idle clean worktrees automatically ([#744](https://github.com/opencue/gitguardex/issues/744)) ([d5413b4](https://github.com/opencue/gitguardex/commit/d5413b48ddf0922df4328a0691c6310f6893406d))
* **cleanup:** enforce watcher branch limits ([#738](https://github.com/opencue/gitguardex/issues/738)) ([d0ec96b](https://github.com/opencue/gitguardex/commit/d0ec96b490ea71181b5ff11f191ac2b5f08fada2))
* **cleanup:** preserve clean worktrees by default ([#741](https://github.com/opencue/gitguardex/issues/741)) ([7568669](https://github.com/opencue/gitguardex/commit/75686690b6573f31056e77517bc8a7e0ca5623eb))
* **cleanup:** prune merged work branches ([#739](https://github.com/opencue/gitguardex/issues/739)) ([b508382](https://github.com/opencue/gitguardex/commit/b5083826874d488436279443490367d04f1a1586))
* **cleanup:** prune opted-in clean linked worktrees ([#737](https://github.com/opencue/gitguardex/issues/737)) ([0285778](https://github.com/opencue/gitguardex/commit/0285778610e9a1849205dd3371cbbc986ee939d9))
* **prune:** preserve actively locked worktrees ([#752](https://github.com/opencue/gitguardex/issues/752)) ([c995c2b](https://github.com/opencue/gitguardex/commit/c995c2b9327bfe43d0d1cf7885a91e6f772a2083))
* recognize sha256 null object ids ([#740](https://github.com/opencue/gitguardex/issues/740)) ([6c66fe1](https://github.com/opencue/gitguardex/commit/6c66fe15eab4e82eb3bc76d2d681cc2e66224bd1))
* **vscode:** prevent stale worktree SCM providers ([#754](https://github.com/opencue/gitguardex/issues/754)) ([4710ce1](https://github.com/opencue/gitguardex/commit/4710ce1291934c33d2207e83c8efa7835e859288))

## [8.2.0](https://github.com/opencue/gitguardex/compare/v8.1.1...v8.2.0) (2026-08-28)


### Features

* cut agent preflight and finish token overhead ([#732](https://github.com/opencue/gitguardex/issues/732)) ([d3ad95a](https://github.com/opencue/gitguardex/commit/d3ad95a6179c96fc6f3fef4905a7aa73fdaafc45))


### Bug Fixes

* **cleanup:** expose command-specific help ([#733](https://github.com/opencue/gitguardex/issues/733)) ([5eaf54d](https://github.com/opencue/gitguardex/commit/5eaf54d5bcd365457005d629164960e6328510fd))
* **doctor:** preserve dirty worktrees during stale pruning ([#730](https://github.com/opencue/gitguardex/issues/730)) ([bd845db](https://github.com/opencue/gitguardex/commit/bd845db13d392b078e3c38864f4e23d861e185f1))
* surface the pane holding a file lock ([#734](https://github.com/opencue/gitguardex/issues/734)) ([2bcfda2](https://github.com/opencue/gitguardex/commit/2bcfda2087f3927f333b005c88428575ab369b78))

## [8.1.1](https://github.com/opencue/gitguardex/compare/v8.1.0...v8.1.1) (2026-08-27)


### Bug Fixes

* **release:** use an OIDC-capable npm runtime ([#728](https://github.com/opencue/gitguardex/issues/728)) ([df3aaee](https://github.com/opencue/gitguardex/commit/df3aaee4318db8740a941f9add94f385ef939c80))

## [8.1.0](https://github.com/opencue/gitguardex/compare/v8.0.0...v8.1.0) (2026-08-27)


### Features

* **collaboration:** add shared Git lock state ([#724](https://github.com/opencue/gitguardex/issues/724)) ([27bac01](https://github.com/opencue/gitguardex/commit/27bac0156cdb914beb28cdbc59a6ad8fb7b427a4))


### Bug Fixes

* **release:** align npm metadata with canonical repo ([#726](https://github.com/opencue/gitguardex/issues/726)) ([4593b54](https://github.com/opencue/gitguardex/commit/4593b541e731500d7b06e23bafc7962eaf48403f))
* **security:** raise the repository Scorecard baseline ([#725](https://github.com/opencue/gitguardex/issues/725)) ([e062dc5](https://github.com/opencue/gitguardex/commit/e062dc5669e96e61dafd8e653c7ebaaba7650add))

## [8.0.0](https://github.com/opencue/gitguardex/compare/v7.1.1...v8.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* **ci:** drop the cr.yml AI-review workflow from templates and this repo ([#680](https://github.com/opencue/gitguardex/issues/680))

### Features

* add GUARDEX_AUTO_SHIP opt-in gated auto-finish toggle ([#662](https://github.com/opencue/gitguardex/issues/662)) ([faefd44](https://github.com/opencue/gitguardex/commit/faefd44da6a12b09b30394c3f26fe3d210f8b70c))
* **agents:** cap CARGO_BUILD_JOBS in agent launch env ([#601](https://github.com/opencue/gitguardex/issues/601)) ([b8ec4ff](https://github.com/opencue/gitguardex/commit/b8ec4ffb00e7eee9138d83bf1f417f57e7f54c2b))
* **agents:** live cockpit lane status + jump (workmux W1) ([#641](https://github.com/opencue/gitguardex/issues/641)) ([153b5c9](https://github.com/opencue/gitguardex/commit/153b5c94cec79de47f8e9e99d1593f9d9ef637bf))
* **branch-finish:** pre-flight gate + auto-promote drafts after pass ([#572](https://github.com/opencue/gitguardex/issues/572)) ([1f11a7c](https://github.com/opencue/gitguardex/commit/1f11a7c9cf3dd55e993fbf2453bb15984e1bb67f))
* **branch:** default gx branch start to tier T1, not T3 ([#632](https://github.com/opencue/gitguardex/issues/632)) ([d08b9fe](https://github.com/opencue/gitguardex/commit/d08b9feb3d2fd94ed32ad30403ed68c66fd9c551))
* **ci:** drop the cr.yml AI-review workflow from templates and this repo ([#680](https://github.com/opencue/gitguardex/issues/680)) ([4ec8bf1](https://github.com/opencue/gitguardex/commit/4ec8bf1a620152818fe035854e16e3498e44f4e4))
* **claude+pr:** first-class Claude Code integration and gx pr command suite ([#600](https://github.com/opencue/gitguardex/issues/600)) ([b61d65b](https://github.com/opencue/gitguardex/commit/b61d65b52fe8eaacffa385ea7a48ed112270d0a4))
* **claude:** add gx pivot/ship + widen hook whitelist for safe sync ops ([#431](https://github.com/opencue/gitguardex/issues/431)) ([f0122ee](https://github.com/opencue/gitguardex/commit/f0122eee6a8220c9dc868f7fc0488ab352d96255))
* **claude:** proactively advise agents on protected branches before they act ([#622](https://github.com/opencue/gitguardex/issues/622)) ([eecab33](https://github.com/opencue/gitguardex/commit/eecab3312a0f95cb4a089645cd598501d15d45e8))
* **cli:** add `gx onboard` guided first-run tour ([#659](https://github.com/opencue/gitguardex/issues/659)) ([a98c2e8](https://github.com/opencue/gitguardex/commit/a98c2e87fc43805874b73625c987c9970d340d1c))
* **cli:** gx budget — Actions usage + paid-spend thresholds ([#574](https://github.com/opencue/gitguardex/issues/574)) ([8b50cc2](https://github.com/opencue/gitguardex/commit/8b50cc2e31b237d4a0531b23a0c2ab44518da68f))
* **cli:** gx ci-init — scaffold budget-friendly workflows into a repo ([#575](https://github.com/opencue/gitguardex/issues/575)) ([795af11](https://github.com/opencue/gitguardex/commit/795af11b9ede78e2077d0717463c1faf05ad2f74))
* **doctor,setup:** auto-prune stale agent worktrees ([#432](https://github.com/opencue/gitguardex/issues/432)) ([3ad44d6](https://github.com/opencue/gitguardex/commit/3ad44d6b3712acf36e4d1fd2103cf8a1ac74774d))
* **doctor:** add token-compression health check ([#654](https://github.com/opencue/gitguardex/issues/654)) ([526a777](https://github.com/opencue/gitguardex/commit/526a7777db52b4f03596e2896260cd8b51652ddd))
* **doctor:** gate auto-finish sweep under GUARDEX_AUTO_SHIP ([#663](https://github.com/opencue/gitguardex/issues/663)) ([a17fe4e](https://github.com/opencue/gitguardex/commit/a17fe4e3eae95775817caac52f90a34a32e59129))
* **finish:** add explicit fast squash profile ([#721](https://github.com/opencue/gitguardex/issues/721)) ([7c83cf0](https://github.com/opencue/gitguardex/commit/7c83cf03fe12835c9762a8ddd1576e5ee39ee0cc))
* **finish:** opt-in merge gate enforces clean review + green CI before merge ([#613](https://github.com/opencue/gitguardex/issues/613)) ([82ea8da](https://github.com/opencue/gitguardex/commit/82ea8da462e2f1741e8023ffba893a1399493bad))
* **finish:** persist live heartbeat events ([#713](https://github.com/opencue/gitguardex/issues/713)) ([17558ca](https://github.com/opencue/gitguardex/commit/17558cadd466837d4b04489dbea4752c99201a15))
* **finish:** show live review elapsed time ([#712](https://github.com/opencue/gitguardex/issues/712)) ([f2ff688](https://github.com/opencue/gitguardex/commit/f2ff6885b8fda031fd61ecdae0a0d940d0b42097))
* **finish:** surface live Codex checklist ([#710](https://github.com/opencue/gitguardex/issues/710)) ([b6ccf4a](https://github.com/opencue/gitguardex/commit/b6ccf4aec36068f0de74983e278d35b9567e4219))
* **gate:** gate on new CI failures instead of absolute green ([#694](https://github.com/opencue/gitguardex/issues/694)) ([7d5e256](https://github.com/opencue/gitguardex/commit/7d5e2569c804c769b2ffeeb94261a695f7d718ac))
* **git:** detect repo default branch instead of hardcoded dev fallback ([#618](https://github.com/opencue/gitguardex/issues/618)) ([a482841](https://github.com/opencue/gitguardex/commit/a4828413c5ad485a66a4ac789808b9eabb271c5c))
* **guard:** treat any non-protected branch as agent-managed ([#626](https://github.com/opencue/gitguardex/issues/626)) ([30dbf1b](https://github.com/opencue/gitguardex/commit/30dbf1b8702520b817609246389082684d32454c))
* **gx:** add `--advance-submodules` flag to `gx branch finish` ([#559](https://github.com/opencue/gitguardex/issues/559)) ([4fca9c5](https://github.com/opencue/gitguardex/commit/4fca9c5d772f699b8f17333b2c7e83906654d9bc))
* **gx:** add `gx submodule advance` verb for monorepo pointer bumps ([#558](https://github.com/opencue/gitguardex/issues/558)) ([f6e3742](https://github.com/opencue/gitguardex/commit/f6e374280c2c44734859450428b242e2dc5a672d))
* **gx:** auto-sync submodule working dirs on `gx setup` for monorepo shops ([#557](https://github.com/opencue/gitguardex/issues/557)) ([835d155](https://github.com/opencue/gitguardex/commit/835d15548e9e04f01f19f8c4421f4ffc04c86403))
* keep multi-agent launches lean by default ([#720](https://github.com/opencue/gitguardex/issues/720)) ([e99ac2b](https://github.com/opencue/gitguardex/commit/e99ac2b1ff0aab15f19399f3346d1d4665c6a556))
* **mcp:** stale-lane detection + pr_lookup_error field ([#633](https://github.com/opencue/gitguardex/issues/633)) ([4f7be98](https://github.com/opencue/gitguardex/commit/4f7be98940c050c503cdf31ac14b0d5cb553e51a))
* **monorepo:** apps/* aware worktrees, preflight, and gx watch ([#606](https://github.com/opencue/gitguardex/issues/606)) ([6f808a7](https://github.com/opencue/gitguardex/commit/6f808a75344e4acf21059f46b23fc27225bef3da))
* **pr-review:** auto-fix findings and rebuild the review presentation ([#693](https://github.com/opencue/gitguardex/issues/693)) ([b753732](https://github.com/opencue/gitguardex/commit/b753732b9c13a5347277418377c3f843bcb23b21))
* **prompt:** compress full gx prompt narrative + document rtk wrapping ([#652](https://github.com/opencue/gitguardex/issues/652)) ([828ab06](https://github.com/opencue/gitguardex/commit/828ab063c8ec678396a33cadb53f59d0403a6123))
* **scaffold:** declarative .guardex.json worktree provisioning (workmux W2) ([#642](https://github.com/opencue/gitguardex/issues/642)) ([77cc650](https://github.com/opencue/gitguardex/commit/77cc6504267a4c57152724e40c84ed235e18d32a))
* **scaffold:** default to minimal multiagent block; full contract opt-in via --contract ([#610](https://github.com/opencue/gitguardex/issues/610)) ([ea18c17](https://github.com/opencue/gitguardex/commit/ea18c1765a54ee44ec1abfd5800304f7f103f167))
* **scripts:** install-global-hooks.sh — opt-in global core.hooksPath ([#603](https://github.com/opencue/gitguardex/issues/603)) ([d60fafa](https://github.com/opencue/gitguardex/commit/d60fafa1241f7039c637b8df0a3a5e45c221e38d))
* **setup:** offer VS Code extension install during gx setup ([#416](https://github.com/opencue/gitguardex/issues/416)) ([0e9131b](https://github.com/opencue/gitguardex/commit/0e9131bc446419bc0b3a63e08361b4521fca3b8a))
* **skills:** add gx-act for running GitHub Actions locally with nektos/act ([#602](https://github.com/opencue/gitguardex/issues/602)) ([14d398c](https://github.com/opencue/gitguardex/commit/14d398c278bbbf4a1d04a8eefc92cf90b9fc6e39))
* **speckit:** add `gx speckit` subcommand to install Spec Kit + prune scaffold ([#588](https://github.com/opencue/gitguardex/issues/588)) ([ed921e6](https://github.com/opencue/gitguardex/commit/ed921e667e384d8c51294fef75f7d23bca228e72))
* **speckit:** run speckit install as part of `gx setup` by default ([#589](https://github.com/opencue/gitguardex/issues/589)) ([a588011](https://github.com/opencue/gitguardex/commit/a588011e6deb71c4eefe7aac9a9ea43cb98bf8b0))
* **status:** surface GUARDEX_COMPRESS_CMD token-compression health ([#653](https://github.com/opencue/gitguardex/issues/653)) ([1c4e6f3](https://github.com/opencue/gitguardex/commit/1c4e6f3197362f460b8b2322723b256c34603ab9))
* **vscode-active-agents:** distinct icons per tree section ([#402](https://github.com/opencue/gitguardex/issues/402)) ([c4e79af](https://github.com/opencue/gitguardex/commit/c4e79afb07a0534f8700cbe4f46e2303c11457ac))
* **vscode-active-agents:** refine file-icon SVGs ([#403](https://github.com/opencue/gitguardex/issues/403)) ([082449f](https://github.com/opencue/gitguardex/commit/082449fb65d5bd22de10ceedf189cdcaebae93e3))
* **vscode-active-agents:** surface colony task counts and details ([#422](https://github.com/opencue/gitguardex/issues/422)) ([43aecbe](https://github.com/opencue/gitguardex/commit/43aecbe78c6e0e5b4cfce56b976131825ce4d91f))
* wire headroom token-saving into gx (advisory part + GUARDEX_COMPRESS_CMD) ([#649](https://github.com/opencue/gitguardex/issues/649)) ([e246d5a](https://github.com/opencue/gitguardex/commit/e246d5abca5918e2582a9bff172444989cf83299))
* **worktree:** prefix worktree leaves with repo basename instead of literal 'agent' ([#406](https://github.com/opencue/gitguardex/issues/406)) ([91ef8a0](https://github.com/opencue/gitguardex/commit/91ef8a0e51fdd7521bbf91e86171dca1376d2797))


### Bug Fixes

* **agent-branch-start:** verify worktree exists before printing Ready: ([#577](https://github.com/opencue/gitguardex/issues/577)) ([7f4d43d](https://github.com/opencue/gitguardex/commit/7f4d43d688b52288ad7b92aad5f63e0bbfb35923))
* **agent-flow:** auto-allow staged deletions + surface gh pr create failures ([#565](https://github.com/opencue/gitguardex/issues/565)) ([1a39ebe](https://github.com/opencue/gitguardex/commit/1a39ebe13ffb75002743794f21ca235759df9adb))
* **agent-worktree-prune:** skip worktrees with live processes ([#570](https://github.com/opencue/gitguardex/issues/570)) ([e1f95b9](https://github.com/opencue/gitguardex/commit/e1f95b93606d386eb7e49a3fb593e6dc7b0ccc3f))
* **branch-finish:** rephrase pending-PR cleanup message so claude doesn't claim the worktree is on disk ([#445](https://github.com/opencue/gitguardex/issues/445)) ([029daa5](https://github.com/opencue/gitguardex/commit/029daa5646e824c586fafbe74312d8abdb1d15c0))
* **branch-start:** archive un-appliable auto-transfer stash instead of leaking it ([#644](https://github.com/opencue/gitguardex/issues/644)) ([cc3d198](https://github.com/opencue/gitguardex/commit/cc3d198213f06cdf11a21bde20f098424e95a536))
* **branch:** forward --review-provider to the merge gate ([#689](https://github.com/opencue/gitguardex/issues/689)) ([f501b2c](https://github.com/opencue/gitguardex/commit/f501b2c92943468d0d1831524620705781c97dd9))
* **branch:** honor --gate-review in `gx branch finish` ([#677](https://github.com/opencue/gitguardex/issues/677)) ([1925f9d](https://github.com/opencue/gitguardex/commit/1925f9d2563c460f56bc30c7a8f51a44c45cf6c0))
* **e2e:** export GUARDEX_CLI_ENTRY/GUARDEX_NODE_BIN to gx shims ([#595](https://github.com/opencue/gitguardex/issues/595)) ([ff93bec](https://github.com/opencue/gitguardex/commit/ff93bec097040be648e0b95dabe88e3cde695e8c))
* **e2e:** export GUARDEX_CLI_ENTRY/HOME/NODE_BIN to every subprocess ([#596](https://github.com/opencue/gitguardex/issues/596)) ([27cdfaa](https://github.com/opencue/gitguardex/commit/27cdfaabe9a7c1bef7d7d2338276890b9361ea9c))
* **finish:** commit dirty linked worktrees before PR ([#714](https://github.com/opencue/gitguardex/issues/714)) ([965df0c](https://github.com/opencue/gitguardex/commit/965df0cb6c7d9d0ebd2d04d1c24ee994f4e5f577))
* **finish:** honor --no-preflight / --no-auto-promote (were normalized before arg-parse) ([#638](https://github.com/opencue/gitguardex/issues/638)) ([5d54e56](https://github.com/opencue/gitguardex/commit/5d54e56e1f5815956702b9efeb29dd7ad41dcae0))
* **finish:** report MERGED as success instead of failing on branch cleanup ([#697](https://github.com/opencue/gitguardex/issues/697)) ([cf4d000](https://github.com/opencue/gitguardex/commit/cf4d000136d0bb9e164e838251e39bf90673c079))
* **finish:** stream branch-finish output instead of buffering it to the end ([#699](https://github.com/opencue/gitguardex/issues/699)) ([9287185](https://github.com/opencue/gitguardex/commit/92871857ee8bc346a0c863e13fe7b2a79faa1b1c))
* **finish:** use repo_root for agent_worktree_root in submodule repos ([#646](https://github.com/opencue/gitguardex/issues/646)) ([efb3a81](https://github.com/opencue/gitguardex/commit/efb3a81130e087b412b64fefcd40bb5da98d3692))
* **gate:** never accept a finding's disappearance as a fix ([#696](https://github.com/opencue/gitguardex/issues/696)) ([42daf81](https://github.com/opencue/gitguardex/commit/42daf81c62e9a28d060f1e37d16e29f3165cfb21))
* **gate:** refuse to merge on a review that was never posted ([#698](https://github.com/opencue/gitguardex/issues/698)) ([7cc5efb](https://github.com/opencue/gitguardex/commit/7cc5efb1167c21c7527ee473d4bd3a15de55b1a6))
* **gate:** unstick the merge gate — stale head, unbounded review, merged-PR misread ([#700](https://github.com/opencue/gitguardex/issues/700)) ([d3c2fd6](https://github.com/opencue/gitguardex/commit/d3c2fd6aa24451aa5f309328d345b0be3399a171))
* **guardex:** auto-stash dirty primary on branch-switch ([#417](https://github.com/opencue/gitguardex/issues/417)) ([56f2675](https://github.com/opencue/gitguardex/commit/56f2675a7b7fca4eaea0a0adaf16fa661ead5671))
* **gx:** deploy PR [#546](https://github.com/opencue/gitguardex/issues/546) fix to runtime via templates/scripts/ + add --auto-resolve=full submodule pointer resolver ([#547](https://github.com/opencue/gitguardex/issues/547)) ([f1cc0ea](https://github.com/opencue/gitguardex/commit/f1cc0eaa16041ab1416e124270126a5d5a162edd))
* **gx:** enforce symlink parity pre-commit + document scripts layout convention ([#553](https://github.com/opencue/gitguardex/issues/553)) ([74e4489](https://github.com/opencue/gitguardex/commit/74e4489f8bc59c6cad865d8ba8d8c8182217d642))
* **gx:** make OpenSpec scaffolding on-by-default and stop the silent-failure log ([#549](https://github.com/opencue/gitguardex/issues/549)) ([89e6c49](https://github.com/opencue/gitguardex/commit/89e6c49e7962e76ad62d6693c0a8ff2492716129))
* **gx:** rename colony package from @imdeadpool/colony-cli to colonyq ([#555](https://github.com/opencue/gitguardex/issues/555)) ([8095f4f](https://github.com/opencue/gitguardex/commit/8095f4fca7d797172fe84823054c5dd5aa2a55c8))
* **gx:** stop branch-start from leaking state files into agent branches; add opt-in safe conflict resolver to finish ([#546](https://github.com/opencue/gitguardex/issues/546)) ([896cabf](https://github.com/opencue/gitguardex/commit/896cabf870b280f3960bb81a11927e23b4e7cb31))
* **gx:** teach gx cleanup the state-file allowlist + log why a dirty worktree was kept ([#550](https://github.com/opencue/gitguardex/issues/550)) ([786cb46](https://github.com/opencue/gitguardex/commit/786cb464739a43ab50378e9422ad75d1a0eec5fc))
* harden verification and lock safety ([#715](https://github.com/opencue/gitguardex/issues/715)) ([7fd6a07](https://github.com/opencue/gitguardex/commit/7fd6a07659d0f2e764fa2a89cb699145cd34792f))
* **hooks:** harden presence registry fail-open (review findings) ([#666](https://github.com/opencue/gitguardex/issues/666)) ([be80385](https://github.com/opencue/gitguardex/commit/be803859286a06b6f55cd6cd4d89da8ec2442f9f))
* **hooks:** restore scripts/agent-stalled-report.sh referenced by SessionStart ([#599](https://github.com/opencue/gitguardex/issues/599)) ([e1278e0](https://github.com/opencue/gitguardex/commit/e1278e07c9e1af242fe90299ead44150ad9e50b7))
* **locks,guard:** address review — mixed-mode lockout + nested-repo over-block ([#635](https://github.com/opencue/gitguardex/issues/635)) ([b6b5785](https://github.com/opencue/gitguardex/commit/b6b5785ab22234647c439c2bae72643e1d58885e))
* **locks:** address review — flock never hard-fails, surface degradations, status unions ([#639](https://github.com/opencue/gitguardex/issues/639)) ([0841e62](https://github.com/opencue/gitguardex/commit/0841e62fb750d97a72c452109309255a27c5b62a))
* **locks:** see claims written by a submodule under a linked worktree ([#643](https://github.com/opencue/gitguardex/issues/643)) ([16632aa](https://github.com/opencue/gitguardex/commit/16632aa0f1ed6da07d1eede8e650ea2a2bae67c5))
* **mcp:** address adversarial review — pin protocol version, bound git calls, add live dirty signal ([#628](https://github.com/opencue/gitguardex/issues/628)) ([609963d](https://github.com/opencue/gitguardex/commit/609963d9acc2453058c417593eee3a72fc8a9b6d))
* **output:** parse GUARDEX_COMPRESS_CMD with shell-quote awareness ([#650](https://github.com/opencue/gitguardex/issues/650)) ([749ec0b](https://github.com/opencue/gitguardex/commit/749ec0bf9ac3f5e5f49febe6f50a633e394b968a))
* **release:** auto-bump direct npm publish versions ([#647](https://github.com/opencue/gitguardex/issues/647)) ([d6944d5](https://github.com/opencue/gitguardex/commit/d6944d585bb6d5a4f910eb78f6b9e8a88e8c94c9))
* **release:** restore a clean npm deployment path ([#195](https://github.com/opencue/gitguardex/issues/195)) ([3faedee](https://github.com/opencue/gitguardex/commit/3faedee7d99481c2e0c902fb2977d1e427ec07a3))
* **release:** target canonical GitHub repository ([#722](https://github.com/opencue/gitguardex/issues/722)) ([01f3c0d](https://github.com/opencue/gitguardex/commit/01f3c0da7081aed4099ee988fb392b45c3e294ef))
* **review:** resolve findings from prior heads ([#711](https://github.com/opencue/gitguardex/issues/711)) ([77b2c6b](https://github.com/opencue/gitguardex/commit/77b2c6b7131ceb667ff9e22bd47a9c58c3de8096))
* **review:** stream code-assist progress ([#707](https://github.com/opencue/gitguardex/issues/707)) ([70988a7](https://github.com/opencue/gitguardex/commit/70988a7ea86099276b73657e15098d90d39fe985))
* **sandbox:** recover stranded worktree dirs during cleanup ([#656](https://github.com/opencue/gitguardex/issues/656)) ([2f06659](https://github.com/opencue/gitguardex/commit/2f06659aba5e038631e0600af67a5d91aaacd0bc))
* **scripts:** handle -h/--help in branch start/finish instead of exit 1 ([#609](https://github.com/opencue/gitguardex/issues/609)) ([49a8ec8](https://github.com/opencue/gitguardex/commit/49a8ec8b9f06911c4ffa3461bb7bbaec429c1f12))
* **skill_guard:** never block edits to files outside the repo working tree ([#614](https://github.com/opencue/gitguardex/issues/614)) ([5ac07f7](https://github.com/opencue/gitguardex/commit/5ac07f730fde43fe0cb3824212c367e349ca3acd))
* **skill_guard:** resolve guarded repo from cwd, not the target file's repo ([#615](https://github.com/opencue/gitguardex/issues/615)) ([befd76e](https://github.com/opencue/gitguardex/commit/befd76e4f6ff26b3a8d966a085e859ca72ce0c0e))
* **stop-hook:** gate the unattended finish instead of merging unreviewed ([#701](https://github.com/opencue/gitguardex/issues/701)) ([d3b4752](https://github.com/opencue/gitguardex/commit/d3b47529627e622960168108e2e5e63e9b70fa8c))
* **update:** hand off to the installed CLI after self-update ([#202](https://github.com/opencue/gitguardex/issues/202)) ([b21e4b8](https://github.com/opencue/gitguardex/commit/b21e4b85d7bf27f8cd55eb6f03a73b2f7e15bc7d))
* **vscode-active-agents:** correct publisher id to Recodee ([#414](https://github.com/opencue/gitguardex/issues/414)) ([0f246d1](https://github.com/opencue/gitguardex/commit/0f246d1d032651ce3627eb04f6fead5675ea69a0))
* **vscode-active-agents:** use SCM Providers category ([#415](https://github.com/opencue/gitguardex/issues/415)) ([1027a0d](https://github.com/opencue/gitguardex/commit/1027a0dc3e8cf96bed859291734b8c5eca35e37f))


### Performance

* **agent:** default to direct work without OpenSpec churn ([#705](https://github.com/opencue/gitguardex/issues/705)) ([dc8bebb](https://github.com/opencue/gitguardex/commit/dc8bebba67e19ce4b065268727a21cf870cea346))
* **context:** memoize idempotent git/gh probes within process ([#586](https://github.com/opencue/gitguardex/issues/586)) ([bb616db](https://github.com/opencue/gitguardex/commit/bb616db408a466308a65c3c22ad7b4b195ce20e1))
* **finish:** bound nested review work ([#706](https://github.com/opencue/gitguardex/issues/706)) ([e7dd2f3](https://github.com/opencue/gitguardex/commit/e7dd2f33e00bc9c5227dd8911b71bf5ab37b2a7d))
* **gate:** run CI alongside the review instead of after it ([#702](https://github.com/opencue/gitguardex/issues/702)) ([3f32c86](https://github.com/opencue/gitguardex/commit/3f32c8666ee6873ea7b777f3c22c4d9afe6f32c4))
* hoist invariant git worktree-list out of the agents-status loop, lazy-require cockpit (plan phase 4) ([#617](https://github.com/opencue/gitguardex/issues/617)) ([2f00891](https://github.com/opencue/gitguardex/commit/2f00891f274e4637ade61f63a80224c175f6cb9d))
* **hooks:** batch pre-commit staged-lock auto-claim into one call ([#695](https://github.com/opencue/gitguardex/issues/695)) ([8aa0af5](https://github.com/opencue/gitguardex/commit/8aa0af50e1525d2a0aced239aabf29561a52d288))
* **hooks:** dedup protected-branch advisor + standardize guard messages ([#627](https://github.com/opencue/gitguardex/issues/627)) ([865fa9e](https://github.com/opencue/gitguardex/commit/865fa9e25e2fd1cdf211edb410180114d66f3bdb))
* **mcp:** compact radar output for list_agents (~80% fewer tokens) ([#637](https://github.com/opencue/gitguardex/issues/637)) ([1cbb8b3](https://github.com/opencue/gitguardex/commit/1cbb8b313a9227ea5b023720c08290f6d784926f))
* memoize npm-list-g probe, route runtime through probe cache, fix budget gh-bin (plan phase 3) ([#616](https://github.com/opencue/gitguardex/issues/616)) ([4c62424](https://github.com/opencue/gitguardex/commit/4c62424eba8b12d749008405fedbe86df3b4a201))
* **output:** default to terse output when stdout is non-TTY ([#585](https://github.com/opencue/gitguardex/issues/585)) ([2e4b75e](https://github.com/opencue/gitguardex/commit/2e4b75ecb5dcb65ef892c312650d671708ce1444))
* **preflight:** quiet by default + fix single-failing-step false pass ([#631](https://github.com/opencue/gitguardex/issues/631)) ([5f53f12](https://github.com/opencue/gitguardex/commit/5f53f12d8c7cbcc98f24a7fdac9e72c93498c6b6))
* **review:** isolate nested Codex automation ([#709](https://github.com/opencue/gitguardex/issues/709)) ([28ecda3](https://github.com/opencue/gitguardex/commit/28ecda3c372dadd5a399280af8c23634936fb80f))
