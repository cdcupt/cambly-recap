# Makefile — Cambly Recap developer entrypoints.

.PHONY: test test-coverage

# Convenience passthroughs to package.json scripts (node --test).
test: ; npm test

test-coverage: ; npm run test:coverage
