# Contributing

- Open an issue first for anything beyond a small fix.
- Every change to how a state is decided comes with a test. Prefer a fixture recorded from a real withdrawal
  (`node scripts/record.mjs <name> <chain> <tx>`) over a hand-made one.
- No dependencies, no keys, no signing. The tool reads public data only.
- Commit messages: a short imperative subject line, then why the change is needed.
