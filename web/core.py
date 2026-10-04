"""Transport-free agent loop for the myharness backend.

Hosts provide model, workspace, persistence, and approval adapters.  This file
intentionally has no Flask, HTTP-server, DOM, or browser dependency so the
same turn engine can be used by a command-line or future TypeScript-parity host.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterator, Protocol


STOPPED_RESULT = "stopped: the user stopped the turn before this tool ran"


@dataclass
class Turn:
    """The prepared state for one user action, owned by a backend session."""

    user_message: dict[str, Any]
    conversation: list[dict[str, Any]]
    setup: dict[str, str]
    enabled_tools: list[str]
    selected_tools: list[dict[str, Any]]
    use_memory: bool
    manual_skill: str = ""


class TurnHost(Protocol):
    """Runtime boundary used by :class:`HarnessCore`.

    Implementations own filesystem, model, persistence and approval mechanics;
    the core owns the sequence of model calls and structured events.
    """

    max_steps: int

    def stopped(self) -> bool: ...
    def model(self) -> str: ...
    def context_length(self) -> int: ...
    def last_prompt_tokens(self) -> int: ...
    def set_last_prompt_tokens(self, value: int) -> None: ...
    def memory_text(self) -> str: ...
    def system_messages(self, setup: dict[str, str], with_skills: bool) -> list[dict[str, Any]]: ...
    def estimate_tokens(self, system: list[dict[str, Any]], conversation: list[dict[str, Any]], tools: list[dict[str, Any]]) -> int: ...
    def trim_context(self, system: list[dict[str, Any]], conversation: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any] | None: ...
    def compact_context(self, conversation: list[dict[str, Any]]) -> Iterator[dict[str, Any]]: ...
    def stream_chat(self, payload: dict[str, Any]) -> Iterator[str]: ...
    def split_json(self, shown: dict[str, Any], highlighted: dict[str, Any]) -> list[str]: ...
    def skill_context(self, context: list[dict[str, Any]]) -> dict[str, Any]: ...
    def run_tool(self, name: str, arguments: dict[str, Any], enabled: list[str]) -> Any: ...
    def apply_change(self, name: str, result: tuple[Any, ...]) -> Iterator[dict[str, Any]]: ...
    def execute_command(self, command: str) -> Iterator[dict[str, Any]]: ...
    def record_event(self, event: dict[str, Any]) -> None: ...


class HarnessCore:
    """Run one complete agent turn and yield transport-neutral event objects."""

    def __init__(self, host: TurnHost):
        self.host = host

    def _emit(self, event: dict[str, Any]) -> dict[str, Any]:
        self.host.record_event(event)
        return event

    def run_turn(self, turn: Turn) -> Iterator[dict[str, Any]]:
        """Advance the agent until it answers, is stopped, or reaches its limit."""
        if turn.manual_skill:
            yield self._emit({"type": "skill", "name": turn.manual_skill})

        compact_attempted = False
        for _ in range(self.host.max_steps):
            system = self.host.system_messages(turn.setup, "use_skill" in turn.enabled_tools)
            if turn.use_memory:
                estimated = self.host.estimate_tokens(system, turn.conversation, turn.selected_tools)
                pressure = max(self.host.last_prompt_tokens(), estimated)
                if pressure >= self.host.context_length() * .75:
                    trimmed = self.host.trim_context(system, turn.conversation, turn.selected_tools)
                    if trimmed:
                        yield self._emit(trimmed)
                if pressure >= self.host.context_length() * .90 and not compact_attempted:
                    compact_attempted = True
                    for event in self.host.compact_context(turn.conversation):
                        event["skill_context"] = self.host.skill_context(system + turn.conversation)
                        yield self._emit(event)
                if self.host.stopped():
                    yield self._emit({"type": "stopped", "reason": "stopped by the user", "memory": self.host.memory_text()})
                    return
                if self.host.estimate_tokens(system, turn.conversation, turn.selected_tools) >= self.host.context_length():
                    yield self._emit({"type": "stopped", "reason": "context full: use Compact or Reset memory", "memory": self.host.memory_text()})
                    return

            payload: dict[str, Any] = {"model": self.host.model(), "messages": system + turn.conversation}
            if turn.selected_tools:
                payload["tools"] = turn.selected_tools
            payload |= {"stream": True, "options": {"num_ctx": self.host.context_length()}}
            marker = "@@HIGHLIGHT@@"
            shown = payload | {"messages": [marker if message is turn.user_message else message for message in payload["messages"]]}
            yield self._emit({
                "type": "request", "parts": self.host.split_json(shown, turn.user_message),
                "memory": self.host.memory_text(), "skill_context": self.host.skill_context(system + turn.conversation),
            })

            reply_parts: list[str] = []
            thinking_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            chunks = self.host.stream_chat(payload)
            chunk: dict[str, Any] = {"message": {}}
            for raw in chunks:
                if self.host.stopped():
                    close = getattr(chunks, "close", None)
                    if close:
                        close()
                    break
                chunk = json.loads(raw)
                if "error" in chunk:
                    raise ValueError(f"Model error: {chunk['error']}")
                message = chunk["message"]
                content = message.get("content", "")
                thinking = message.get("thinking", "")
                reply_parts.append(content)
                thinking_parts.append(thinking)
                tool_calls += message.get("tool_calls", [])
                if thinking:
                    yield self._emit({"type": "thinking", "content": thinking})
                if not chunk.get("done"):
                    yield self._emit({"type": "chunk", "content": content})

            reply = "".join(reply_parts)
            if self.host.stopped():
                if reply:
                    turn.conversation.append({"role": "assistant", "content": reply})
                yield self._emit({"type": "stopped", "reason": "stopped by the user", "memory": self.host.memory_text()})
                return
            if not chunk.get("done"):
                raise ValueError("The model stream ended before completion")
            assistant_message: dict[str, Any] = {"role": "assistant", "content": reply}
            if tool_calls:
                assistant_message["tool_calls"] = tool_calls
            turn.conversation.append(assistant_message)
            received_message: dict[str, Any] = {"role": "assistant"}
            if "".join(thinking_parts):
                received_message["thinking"] = "".join(thinking_parts)
            received_message |= assistant_message

            tokens_in = chunk.get("prompt_eval_count", 0)
            if turn.use_memory:
                self.host.set_last_prompt_tokens(tokens_in)
            tokens_out = chunk.get("eval_count", 0)
            used = tokens_in + tokens_out
            yield self._emit({
                "type": "response", "parts": self.host.split_json(chunk | {"message": marker}, received_message),
                "tokens": f"[{tokens_in} in + {tokens_out} out = {used} |{used} / {self.host.context_length()} ]",
                "tokens_in": tokens_in, "context_length": self.host.context_length(), "memory": self.host.memory_text(),
                "content": reply,
            })
            if not tool_calls:
                if not reply:
                    yield self._emit({"type": "stopped", "reason": "The model returned an empty reply. Send another message to try again.", "memory": self.host.memory_text()})
                return

            for call in tool_calls:
                name = call["function"]["name"]
                arguments = call["function"].get("arguments", {})
                result: Any = STOPPED_RESULT if self.host.stopped() else self.host.run_tool(name, arguments, turn.enabled_tools)
                if isinstance(result, tuple):
                    events = self.host.apply_change(name, result)
                    result = yield from self._yield_action(events)
                elif isinstance(result, dict):
                    result = yield from self._yield_action(self.host.execute_command(result["command"]))
                turn.conversation.append({"role": "tool", "tool_name": name, "content": result})
                yield self._emit({
                    "type": "tool", "name": name, "arguments": json.dumps(arguments), "result": result,
                    "memory": self.host.memory_text(), "skill_context": self.host.skill_context(system + turn.conversation),
                })
            if self.host.stopped():
                yield self._emit({"type": "stopped", "reason": "stopped by the user", "memory": self.host.memory_text()})
                return

        yield self._emit({"type": "stopped", "reason": f"stopped after {self.host.max_steps} calls to the model"})

    def _yield_action(self, events: Iterator[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        result: Any = None
        while True:
            try:
                event = next(events)
            except StopIteration as completed:
                return completed.value
            yield self._emit(event)
