// TEST-ONLY: a bare Electron main process that shows harness scenes in windows the spec opens.
// Same Chromium as the product; never packaged.
import { app, nativeTheme } from "electron";

nativeTheme.themeSource = "dark";
app.on("window-all-closed", () => {}); // the spec opens and closes scene windows one by one
