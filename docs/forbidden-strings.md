# The forbidden-string gate

The kit is meant to be shared, so no identifier from another project's tenant may appear in a tracked file. `npm run check:forbidden`
(`scripts/check-forbidden-strings.mjs`) fails when a tracked file contains

- any line of the **forbidden-strings list** (matched case-insensitively; a hit is reported as `file:line entry #N`, never as the value),
- a UUID in docs or examples that `scripts/forbidden-allowlist.json` does not list, or
- a private Ping hostname that the allowlist does not list.

The list itself holds the very identifiers it guards against, so it is **never committed**.

## Where CI gets the list

The `forbidden-strings` job in `.github/workflows/ci.yml` writes the `FORBIDDEN_STRINGS` repository secret (one string per line) to a
temporary file and points `FORBIDDEN_STRINGS_FILE` at it. With no secret the job fails under `CI=true`: the gate cannot be skipped.
Only counts and `file:line` positions are printed, never the strings.

## Run it locally with the real list

Keep your own copy of the list outside this repository (the script never writes it), then:

```sh
FORBIDDEN_STRINGS_FILE=/path/to/your/forbidden-strings.txt npm run check:forbidden
```

Without `FORBIDDEN_STRINGS_FILE` the exact-string check is skipped locally (with a notice) and the host and UUID checks still run.

## Allowlist

`scripts/forbidden-allowlist.json` lists hosts and UUIDs the gate lets through, each with a reason. Add an entry only for a
placeholder (an `.example` / `.invalid` host or an obviously fake id), never for a real identifier.
