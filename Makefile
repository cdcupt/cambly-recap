# Makefile — Cambly Recap developer entrypoints.

.PHONY: test test-coverage push-state

# Convenience passthroughs to package.json scripts (node --test).
test: ; npm test

test-coverage: ; npm run test:coverage

# Second half of the auth-recovery ritual, quoted verbatim in the auth-expired
# email and the site's stale-auth banner:
#   ① cd ~/browser-automation && node cambly/refresh.js
#   ② cd ~/codes/github.com/cambly-recap && make push-state
#
# This target existed in the instructions but never in the Makefile, so step ②
# died on "No rule to make target" the first time a session actually expired
# (2026-08-03). bin/push-state.sh is a private artifact (see .gitignore) because
# it carries the operator's host and paths — so guard instead of failing obscurely
# for anyone working from the public repo.
push-state:
	@test -x bin/push-state.sh || { \
	  echo "bin/push-state.sh is not present (private operator script)."; \
	  echo "Copy cambly-state.json to the server, then re-run the generator."; \
	  exit 1; }
	@bash bin/push-state.sh --run
