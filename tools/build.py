#!/usr/bin/env python3
"""Сборка расширения «Чат Легиона» из того же кода, что и userscript.

    python3 tools/build.py

Кладёт в dist/:
  legion-chat-chrome.zip   — Chrome, Edge, Opera, Яндекс Браузер (Manifest V3, service worker)
  legion-chat-firefox.zip  — Firefox 121+ (Manifest V3, фоновые скрипты, id расширения)
  legion-chat.user.js      — userscript для Tampermonkey / Violentmonkey
Версия расширения берётся из @version userscript'а.
"""
import json, re, shutil, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'legion-chat.user.js'
EXT = ROOT / 'extension'
DIST = ROOT / 'dist'

code = SRC.read_text(encoding='utf8')
version = re.search(r'@version\s+(\S+)', code).group(1)

MATCHES = ['https://play.multidonate.ru/c/*', 'https://play.multidonate.ru/site/ver*']
ICONS = {str(n): f'icons/icon-{n}.png' for n in (16, 32, 48, 128)}
base = {
    'manifest_version': 3,
    'name': 'Чат Легиона',
    'version': version,
    'description': 'Чат шахты и города игры «Легион» (play.multidonate.ru): панель в игре, отдельное окно, личные, стикеры 7TV, модерация.',
    'homepage_url': 'https://github.com/frebertor-sudo/legion-chat-window',
    'icons': ICONS,
    'action': {'default_title': 'Открыть чат Легиона', 'default_icon': ICONS},
    'content_scripts': [{
        'matches': MATCHES,
        'js': ['legion-chat.js'],
        'run_at': 'document_start',
        'all_frames': True,   # окно чата открывается и рамкой внутри игры
    }],
}
chrome = dict(base, background={'service_worker': 'background.js'})
firefox = dict(base, background={'scripts': ['background.js']}, browser_specific_settings={'gecko': {
    'id': 'legion-chat@frebertor-sudo.github.io',
    'strict_min_version': '121.0',
    # Firefox просит заявить, собирает ли расширение данные: не собирает
    'data_collection_permissions': {'required': ['none']},
}})

assert len(base['description']) <= 132, 'описание для Chrome Web Store — не длиннее 132 символов'
DIST.mkdir(exist_ok=True)

def pack(name, manifest):
    out = DIST / name
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        z.writestr('legion-chat.js', code)
        z.write(EXT / 'background.js', 'background.js')
        for rel in ICONS.values():
            z.write(EXT / rel, rel)
    return out

for out in (pack('legion-chat-chrome.zip', chrome), pack('legion-chat-firefox.zip', firefox)):
    print(f'{out.relative_to(ROOT)}  ({out.stat().st_size // 1024} КБ)')
shutil.copyfile(SRC, DIST / 'legion-chat.user.js')
print(f'dist/legion-chat.user.js\nверсия {version}')
