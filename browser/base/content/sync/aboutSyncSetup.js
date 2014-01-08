/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");

const ABOUT_ACCOUNTS = "about:accounts";

function getChromeWindow() {
  return window.QueryInterface(Ci.nsIInterfaceRequestor)
                   .getInterface(Ci.nsIWebNavigation)
                   .QueryInterface(Ci.nsIDocShellTreeItem)
                   .rootTreeItem
                   .QueryInterface(Ci.nsIInterfaceRequestor)
                   .getInterface(Ci.nsIDOMWindow);
}

function openLink(url) {
  // If we are in a tab we replace the tab.  If we are in a dialog, it
  // will be the preferences dialog, so close it and open a new tab.
  let chromeWin = getChromeWindow();
  if (chromeWin.gBrowser) {
    // we are in a tab - just reset the location.
    window.location = url;
  } else {
    // must be in the preferences dialog - close it
    chromeWin.close();
    // and switch to/open a tab.
    let browserWin = Services.wm.getMostRecentWindow("navigator:browser");
    browserWin.switchToTabHavingURI(url, true);
  }
}

// Button onclick handlers
function handleOldSync() {
  // if this is in a tab, do we close it?
  let url = Services.urlFormatter.formatURLPref("app.support.baseURL") + "sync-migration";
  openLink(url);
}

function getStarted() {
  openLink(ABOUT_ACCOUNTS);
}
