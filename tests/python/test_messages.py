"""User-facing messages are English: the server's errors reach the UI and CLI as written."""

import ast
import re
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src" / "ink_viewer"
SPANISH = re.compile(
    r"[áéíóúñ¿¡]|\b(invalid[oa]s?|mascara|carpeta|falta|debe|esperaba|archivo|recarga|"
    r"configura|usa|hay|mayor|solo|pertenece|requiere|arrancando|anotaciones)\b",
    re.I,
)
RAISED = (
    "ValueError",
    "PermissionError",
    "FileNotFoundError",
    "HTTPError",
    "RuntimeError",
    "error",
    "send_error",
    "exit",
)


def messages(tree):
    """String constants passed to exceptions, argparse errors, send_error and log()."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name in RAISED or name == "log":
                for arg in node.args:
                    for const in ast.walk(arg):
                        if isinstance(const, ast.Constant) and isinstance(const.value, str):
                            yield const
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "error":
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        yield value


class Messages(unittest.TestCase):
    def test_user_facing_messages_are_english(self):
        found = []
        for path in sorted(SRC.rglob("*.py")):
            for const in messages(ast.parse(path.read_text())):
                # API paths (/api/mascara-par) are identifiers, not prose.
                if SPANISH.search(re.sub(r"/api/\S+", "", const.value)):
                    found.append(f"{path.relative_to(SRC)}:{const.lineno}: {const.value!r}")
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
