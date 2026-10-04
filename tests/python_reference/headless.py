"""Retired Python HTTP client retained for migration regression tests."""

import argparse
import json
import sys

import requests


def post_json(base_url: str, path: str, body: dict) -> requests.Response:
    response = requests.post(f"{base_url}{path}", json=body, timeout=30)
    response.raise_for_status()
    return response


def main() -> int:
    parser = argparse.ArgumentParser(description="Use myharness without its browser UI.")
    parser.add_argument("message", nargs="?", help="Message to submit to the harness")
    parser.add_argument("--url", default="http://localhost:5000", help="Backend base URL")
    parser.add_argument("--tools", default="", help="Comma-separated enabled tool names")
    parser.add_argument("--no-memory", action="store_true", help="Do not retain this turn")
    parser.add_argument("--approve", action="store_true", help="Approve requested changes and commands")
    parser.add_argument("--reset", action="store_true", help="Reset retained memory before exiting")
    args = parser.parse_args()
    base_url = args.url.rstrip("/")

    try:
        response = requests.get(f"{base_url}/bootstrap", timeout=30)
        response.raise_for_status()
        state = response.json()
        if args.reset:
            print(post_json(base_url, "/reset", {}).json()["memory"])
            return 0
        if not args.message:
            parser.error("message is required unless --reset is used")
        session = state.get("session", {})
        tools = [name.strip() for name in args.tools.split(",") if name.strip()]
        if not tools:
            tools = session.get("settings", {}).get("tools", [])
        payload = {
            "session_id": session.get("id", ""), "message": args.message,
            "use_memory": not args.no_memory, "tools": tools, "ask_approval": True,
            "agent": session.get("setup", {}).get("agent", ""),
            "prompt": session.get("setup", {}).get("prompt", ""),
        }
        response = requests.post(f"{base_url}/chat", json=payload, stream=True, timeout=(30, 300))
        response.raise_for_status()
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            event = json.loads(line)
            print(json.dumps(event, ensure_ascii=False))
            if event.get("type") == "approval":
                post_json(base_url, "/approve", {"id": event["id"], "approved": args.approve})
    except KeyboardInterrupt:
        requests.post(f"{base_url}/stop", timeout=5)
        return 130
    except (requests.RequestException, ValueError, KeyError) as error:
        print(f"headless harness failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
