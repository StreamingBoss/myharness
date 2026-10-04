"""Compare the Qwen prompt reconstruction with Ollama's actual input token counts.

Run manually: .venv/bin/python scratchpad/verify_render.py
Uses a temporary project and Ollama directly; never contacts the Flask server.
"""

import sys
import tempfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web"))
import app as harness


def verify():
    window = harness.get_context_length(harness.MODEL)
    with tempfile.TemporaryDirectory(prefix="myharness-render-") as folder:
        harness.workspace = Path(folder)
        (harness.workspace / "AGENTS.md").write_text("Project: Little Calculator. Inspect files before explaining code.")
        messages = harness.system_messages({"agent": "", "prompt": ""}, False) + [
            {"role": "user", "content": "Say hello."}
        ]
        common = {"model": harness.MODEL, "stream": False,
                  "options": {"num_ctx": window, "num_predict": 1}}
        cases = [("AGENTS.md", [])] + [
            (name, [tool for tool in harness.TOOLS if tool["function"]["name"] == name])
            for name in ("read_file", "find_files", "search")
        ]
        for name, tools in cases:
            response = requests.post(harness.OLLAMA_URL + "/api/chat",
                                     json=common | {"messages": messages, "tools": tools}, timeout=120)
            response.raise_for_status()
            raw = requests.post(harness.OLLAMA_URL + "/api/generate", json=common | {
                "prompt": harness.render_qwen_prompt(messages, tools), "raw": True,
            }, timeout=120)
            raw.raise_for_status()
            actual = response.json()["prompt_eval_count"]
            reconstructed = raw.json()["prompt_eval_count"]
            print(f"{name}: Ollama={actual}, reconstruction={reconstructed}", flush=True)
            if abs(actual - reconstructed) > len(tools):
                raise AssertionError(f"Prompt token-count mismatch for {name}")


if __name__ == "__main__":
    verify()
