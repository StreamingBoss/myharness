---
name: write-readme
description: How to write a clear, accurate README.md for a project. Use when the user asks to create, write or improve a README.
---
# Writing a README

1. Look at the project first: list_files, then read_file on the main source files and any
   existing README.md. Only describe what the code actually does.
2. If you can, run the main program with run_command to see its real output.
3. Write README.md with these sections, in this order:
   - `# <Project name>` and one or two sentences: what it is and what it's for.
   - `## Requirements`: language version and dependencies (look for requirements.txt or imports).
   - `## How to run`: the exact command(s), in a code block.
   - `## Example`: a real command and the output it produces.
4. Keep it short: no badges, no invented features, no "coming soon" sections.
5. If README.md already exists, change it with edit_file instead of rewriting it, and keep any
   accurate content.
