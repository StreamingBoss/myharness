# Recorded sessions

Sessions shipped with the browser edition. Each is an ordinary session export (**Session → Export session**) kept as
`recorded-sessions/<language>/<file>.json`, where `<language>` is an interface language code (`en`, `fr`, `zh`, ...).
The page lists those of its language (English when a language has none) in the "Recorded sessions" group of the session
list, in file-name order, so prefix file names with a number to order them (`1-raw-llm.json`).

Record in the browser edition with a real model, so the workspace is the virtual `/workspace`: the build refuses a
recording that mentions a path from your computer. A recording keeps the model's exact answers.
