---
name: run-python-tests
description: How to write and run Python tests, then fix failures. Use when the user asks to add, write, run or fix tests for Python code.
---
# Writing and running Python tests

1. Read the code you are testing with read_file. Note each function's inputs, outputs and edge cases.
2. BEFORE writing any test, check which test runner is available with run_command:
   `python3 -m pytest --version`.
   - If it works, use pytest: plain functions named `test_...` with `assert`.
   - If it fails, use the standard library: `unittest`, with a class that inherits
     `unittest.TestCase` and methods named `test_...`.
   - Never install packages (no pip install, no apt): unittest always works.
3. Write the tests in a new file next to the code, named `test_<module>.py`, with write_file.
   - Import the code under test: `from <module> import <function>`.
   - Cover a normal case, an edge case (empty input, 0, 1, a large value) and, if relevant,
     an invalid input.
   - Keep one idea per test, with a name that says what it checks.
4. Run the tests with run_command:
   - pytest: `python3 -m pytest -q test_<module>.py`
   - unittest: `python3 -m unittest -v test_<module>`
5. If a test fails, read the error. Decide whether the test or the code is wrong; don't change
   correct code to make a wrong test pass. Fix it with edit_file, then run the tests again.
6. Finish with a short summary: which tests exist, and the final result (for example "5 passed").
