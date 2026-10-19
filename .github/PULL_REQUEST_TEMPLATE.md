## Summary

What does this PR change, and why? One or two sentences.

## How it was verified

Run the gates and check them off — CI runs the same ones:

- [ ] `npm run verify` (build + typecheck + tests + cross-app demo)
- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo fmt --all -- --check`
- [ ] `node tools/scoreboard.mjs --check ts` and `--check rust` (updated
      `docs/scoreboard.md` if your change affects a measured claim)

## Notes

- Behaviour change for users? Mention it so release notes can pick it up.
- Touches `schemas/`? Regenerate the client code — `schemas/` is the single
  source of truth.
