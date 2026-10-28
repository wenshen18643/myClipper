# myClipper artwork

The mark is a stack of clip cards (slate, light blue, gold) with a navy play button. The app icon puts it on a navy rounded tile; the lockup adds the "myClipper" wordmark.

Regenerate everything (SVGs in `resources/`, `resources/myclipper-icon.png`, and `build/icon.png`, `build/icon.ico`, `build/icon.icns`) with:

```
engine/.venv/Scripts/python.exe scripts/icon/build-myclipper-art.py
```

Colours and shapes live at the top of `build-myclipper-art.py`.
