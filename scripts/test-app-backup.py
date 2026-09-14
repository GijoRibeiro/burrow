"""Exercise retirement with actual ad-hoc signed macOS fixture bundles."""
import importlib.util
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("retire", Path(__file__).with_name("retire-app-backup.py"))
retirement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retirement)


class RetirementTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="burrow-backup-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.bundle("previous", "1")
        self.current = self.bundle("current", "2")

    def bundle(self, name, version, identifier="com.cloovies.backup-test"):
        app = self.root / (name + ".app")
        (app / "Contents/MacOS").mkdir(parents=True)
        shutil.copyfile("/usr/bin/true", app / "Contents/MacOS/Fixture")
        (app / "Contents/MacOS/Fixture").chmod(0o755)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": identifier, "CFBundleExecutable": "Fixture",
            "CFBundleVersion": version, "CFBundlePackageType": "APPL",
        }))
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True, capture_output=True)
        return app

    def test_archive_and_redirect(self):
        original = (self.old / "Contents/MacOS/Fixture").read_bytes()
        current = (self.current / "Contents/MacOS/Fixture").read_bytes()
        archive = retirement.retire(self.old, self.current)
        self.assertTrue(self.old.is_symlink())
        self.assertEqual(self.old.resolve(), self.current.resolve())
        self.assertEqual((self.old / "Contents/MacOS/Fixture").read_bytes(), current)
        with zipfile.ZipFile(archive) as saved:
            self.assertEqual(saved.read("previous.app/Contents/MacOS/Fixture"), original)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(self.old)], check=True)
        self.assertEqual(retirement.retire(self.old, self.current), archive)

    def test_refuses_same_app(self):
        with self.assertRaises(ValueError):
            retirement.retire(self.current, self.current)
        self.assertTrue(self.current.is_dir())

    def test_refuses_different_identity(self):
        other = self.bundle("other", "3", "com.cloovies.other-test")
        with self.assertRaises(ValueError):
            retirement.retire(self.old, other)
        self.assertFalse(self.old.is_symlink())

    def test_preserves_existing_archive(self):
        archive = self.old.with_suffix(".zip")
        archive.write_bytes(b"existing recovery copy")
        with self.assertRaises(FileExistsError):
            retirement.retire(self.old, self.current)
        self.assertEqual(archive.read_bytes(), b"existing recovery copy")
        self.assertFalse(self.old.is_symlink())

    def test_refuses_invalid_replacement_signature(self):
        info = self.current / "Contents/Info.plist"
        values = plistlib.loads(info.read_bytes())
        values["CFBundleVersion"] = "unsigned change"
        info.write_bytes(plistlib.dumps(values))
        with self.assertRaises(subprocess.CalledProcessError):
            retirement.retire(self.old, self.current)
        self.assertFalse(self.old.is_symlink())


if __name__ == "__main__":
    unittest.main()
