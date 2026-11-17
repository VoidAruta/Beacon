## Summary / Описание изменений
<!-- Briefly describe what this PR changes and why -->

## Architecture & Security Checklist / Чек-лист инвариантов
- [ ] Process isolation (`os.setsid` / `os.killpg`) and direct file-descriptor logging (`buffering=0`, no `subprocess.PIPE`) are preserved.
- [ ] Memory enforcement uses PGID RSS summation (no `RLIMIT_AS`).
- [ ] No runtime files from `data/` (`*.db`, secrets, tokens, logs, backups) or private projects are included in the commit.
- [ ] All backend and frontend unit tests pass:
  - `python3 -m unittest discover -s tests -v`
  - `npx tsx --test src/utils/hubLogic.test.ts`
- [ ] If `src/` was modified, `npm run build` was executed so `hub/static/` is up to date.
