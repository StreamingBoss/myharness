MyHarness tokenizer helper
==========================

This optional program lets the MyHarness token viewer show how a local Ollama
model splits a request into tokens. It tokenizes text and does nothing else: it
reads no project files, runs no commands and holds no conversation. It only
answers the websites it is started for.

It is one small program, token-helper (token-helper.exe on Windows), and needs
nothing else installed.

Use it
------
1. Start the helper in a terminal, in this folder:

     ./token-helper                       (Windows: token-helper.exe)

   It serves https://harnessarium.com. For another page, name it exactly:

     ./token-helper --origin http://localhost:5001

2. In the harness, open Tokens, open "Show token pieces for my Ollama model"
   and click Connect. After that the page reconnects by itself whenever the
   helper is running.

Start at every login
--------------------
     ./token-helper --install             (add the same --origin, if you use one)
     ./token-helper --uninstall

This adds an entry for your user account only and needs no administrator
rights. If you move this folder afterwards, run --install again.

First start on macOS and Windows
--------------------------------
These downloads are not signed by a registered developer, so the system asks
for confirmation the first time.
  macOS:   if the system refuses to open the program, allow it under System
           Settings > Privacy & Security ("Open Anyway").
  Windows: in the "Windows protected your PC" window, choose "More info",
           then "Run anyway".

Settings (optional, as environment variables)
---------------------------------------------
  OLLAMA_URL                  Ollama address, default http://localhost:11434
  MYHARNESS_TOKENIZER_MODELS  JSON map from an exact Ollama model ID to its GGUF
                              file, for Docker or remote Ollama
  MYHARNESS_WSL_MOUNT_ROOT    where WSL mounts Windows drives, default /mnt
See TOKENIZATION.md in the MyHarness repository for details.
