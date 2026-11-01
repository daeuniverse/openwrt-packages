import html
import importlib.util
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('generate.py')
spec = importlib.util.spec_from_file_location('generate', SCRIPT)
generate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generate)
BASE = 'https://openwrt.daeuniverse.org'
RSYNC = 'rsync://openwrt.daeuniverse.org/openwrt-daeuniverse'


class MarkdownTests(unittest.TestCase):
    def test_pages_match_shared_content(self):
        fixtures = [
            '',
            '25.12/packages/x86_64/packages.adb\n',
            '25.12/kmods/25.12.6/x86/64/packages.adb\n',
            '25.12/packages/aarch64_generic/packages.adb\n'
            '25.12/kmods/25.12.6/x86/64/packages.adb\n'
            '25.12/kmods/25.12.5/x86/64/packages.adb\n'
            '25.12/kmods/25.12.6/mediatek/filogic/packages.adb\n'
            '26.01/packages/x86_64/packages.adb\n',
        ]
        for fixture in fixtures:
            for lang, _, _ in generate.LANGS:
                with self.subTest(fixture=fixture, lang=lang):
                    text = generate.texts(lang, generate.TEXT[lang])
                    bodies = {
                        'index.html': generate.guide(lang, text, generate.read_builds(fixture.splitlines()), BASE),
                        'mirror.html': generate.mirror(text, RSYNC),
                        'thanks.html': generate.thanks(lang, text),
                    }
                    for name, (sections, body) in bodies.items():
                        md = generate.markdown_page(text, BASE, bodies, name, body)
                        self.assertTrue(md.startswith('# '))
                        for _, title in sections:
                            self.assertIn('## ' + title, md)
                        commands = [html.unescape(re.sub('<[^>]*>', '', code))
                                    for code in re.findall(r'<pre><code>(.*?)</code></pre>', body, re.S)]
                        self.assertEqual(commands, re.findall(r'```sh(?: \[[^\]\n]+\])?\n(.*?)\n```', md, re.S))
                        for href in re.findall(r'href="(\.\./[^"]+)"', body):
                            self.assertIn('](' + BASE + '/' + html.unescape(href[3:]) + ')', md)
                        self.assertNotRegex(md, r'<(?:script|style|button|fieldset|span|svg)\b')
                        self.assertNotIn('](../', md)
                        self.assertIn(f']({BASE}/files/)', md)
                        self.assertIn(f']({BASE}/public-key.pem)', md)
                        for other in bodies:
                            if other != name:
                                self.assertIn('./' + other.replace('.html', '.md'), md)
                    guide = generate.markdown_page(text, BASE, bodies, 'index.html', bodies['index.html'][1])
                    for app in ('dae', 'honk'):
                        self.assertIn(f'<div class="tab-variant" data-tab="{app}">', guide)
                        self.assertIn(f'`/etc/{app}/config.dae`', guide)
                    self.assertNotIn('/etc/dae/config.dae/etc/honk/config.dae', guide)
                    self.assertRegex(guide, r'(?s)::: code-group\n\n```sh \[OpenWrt\]\n.*?```sh \[ImmortalWrt\]\n.*?\n:::', )
                    self.assertIn('<a id="local-package-pin"></a>', guide)
                    self.assertIn('](#local-package-pin)', guide)

    def test_code_preserves_whitespace_and_backticks(self):
        command = "cat <<'EOF'\n\n\n```\n<&>\nEOF"
        md = generate.markdown_body(generate.code(command, generate.TEXT['en']), BASE)
        self.assertEqual(md, '````sh\n' + command + '\n````')

    def test_custom_base_and_page_links(self):
        body = '<p><a href="../files/">files</a> <a href="mirror.html">mirror</a> <a href="./">guide</a></p>'
        md = generate.markdown_body(body, 'https://mirror.example/feed')
        self.assertIn('](https://mirror.example/feed/files/)', md)
        self.assertIn('](./mirror.md)', md)
        self.assertIn('](./index.md)', md)

    def test_cli_optional_mirror(self):
        for rsync in ([], [RSYNC]):
            with self.subTest(rsync=rsync), tempfile.TemporaryDirectory() as directory:
                subprocess.run([sys.executable, str(SCRIPT), directory, BASE + '/', *rsync],
                               input='', text=True, check=True, capture_output=True)
                for lang, _, _ in generate.LANGS:
                    folder = Path(directory) / lang
                    self.assertEqual({p.stem for p in folder.glob('*.html')},
                                     {p.stem for p in folder.glob('*.md')})
                    self.assertEqual((folder / 'mirror.md').exists(), bool(rsync))
                    self.assertTrue((folder / 'index.md').read_text().startswith('# '))


if __name__ == '__main__':
    unittest.main()
