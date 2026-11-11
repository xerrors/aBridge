UV ?= uv

.DEFAULT_GOAL := check
.PHONY: sync lint format test web-check build check

sync:
	$(UV) sync --locked --extra dev

lint:
	$(UV) run --no-sync ruff check abridge deploy native tests
	$(UV) run --no-sync ruff format --check abridge deploy native tests

format:
	$(UV) run --no-sync ruff check --select I --fix abridge deploy native tests
	$(UV) run --no-sync ruff format abridge deploy native tests

test:
	$(UV) run --no-sync pytest -q

web-check:
	node --check abridge/static/app.js

build:
	$(UV) build --clear --no-sources
	@set -eu; package_smoke_dir=$$(mktemp -d); \
	trap 'rm -rf "$$package_smoke_dir"' EXIT; \
	$(UV) run --isolated --no-project --directory "$$package_smoke_dir" \
		--with "$(CURDIR)"/dist/*.whl python -c \
		'from importlib.resources import files; root = files("abridge") / "static"; assert all((root / name).is_file() for name in ("index.html", "app.js", "app.css", "brand.svg")), "Missing packaged web assets"'; \
	$(UV) run --isolated --no-project --directory "$$package_smoke_dir" \
		--with "$(CURDIR)"/dist/*.whl abridge --help

check: sync
	$(MAKE) lint test web-check build
