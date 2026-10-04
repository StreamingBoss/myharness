import type { ToolDefinition } from "../core.js";

export const TOOLS: ToolDefinition[] = [
  {
    "type": "function",
    "function": {
      "name": "find_files",
      "description": "Find files in the project folder by filename or relative-path wildcard; sorted, at most 200 results. Skips dependency and cache folders.",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "Wildcard pattern, e.g. '*.py' or 'src/*'"
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "search",
      "description": "Search text in the project folder, case-sensitive plain substring (no regex). Returns file:line: text, at most 100 matches. Skips binary, dependency and cache files.",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "Literal text to find"
          },
          "path": {
            "type": "string",
            "description": "File or folder in the project folder (default '.')"
          },
          "glob": {
            "type": "string",
            "description": "Filename or relative-path wildcard (default '*')"
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "get_current_time",
      "description": "Get the current local date and time",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "pwd",
      "description": "Get the full path of the project folder, the folder that list_files and read_file work in",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "list_files",
      "description": "List the files and folders in the project folder. Folders end with '/'.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Folder inside the project folder, '.' for the top"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read numbered lines of a text file in the project folder. Use start_line/end_line for a range; follow the continuation hint for more.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "File path inside the project folder, e.g. 'README.md'"
          },
          "start_line": {
            "type": "integer",
            "description": "First line, inclusive (default 1)"
          },
          "end_line": {
            "type": "integer",
            "description": "Last line, inclusive (default end of file)"
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Create a new file in the project folder, or replace a file's whole content. Use edit_file instead to change part of an existing file.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "File path inside the project folder, e.g. 'src/app.py'"
          },
          "content": {
            "type": "string",
            "description": "The complete file content"
          }
        },
        "required": [
          "path",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit_file",
      "description": "Change part of an existing file: replaces old_text with new_text. old_text must match the file exactly (spaces and indentation included) and appear only once. Read the file first.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "File path inside the project folder"
          },
          "old_text": {
            "type": "string",
            "description": "The exact text to replace, copied from the file"
          },
          "new_text": {
            "type": "string",
            "description": "The text to put instead"
          }
        },
        "required": [
          "path",
          "old_text",
          "new_text"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "run_command",
      "description": "Run a shell command (bash) in the project folder and get its output and exit code. Use it to run scripts and tests, e.g. 'python3 primes.py', to check that code works. Commands are stopped after 60 seconds.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The bash command to run"
          }
        },
        "required": [
          "command"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "use_skill",
      "description": "Load a skill: detailed instructions for a specific task. Call it when the task matches a skill listed in the system message, then follow what it returns.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The skill's name, from the list"
          }
        },
        "required": [
          "name"
        ]
      }
    }
  }
];
export const TOOL_NAMES = TOOLS.map(tool => tool.function.name);
