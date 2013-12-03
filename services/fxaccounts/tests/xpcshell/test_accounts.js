/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Cu.import("resource://services-common/utils.js");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FxAccounts.jsm");
Cu.import("resource://gre/modules/Promise.jsm");

// BackstagePass that gives us atob when building on b2g.
// (This is not necessary when building browser; I know not why.)
let atob = Cu.import("resource://gre/modules/Log.jsm").atob;

function run_test() {
  run_next_test();
}

add_test(function test_non_https_remote_server_uri() {
  Services.prefs.setCharPref(
    "firefox.accounts.remoteUrl",
    "http://example.com/browser/browser/base/content/test/general/accounts_testRemoteCommands.html");
  do_check_throws_message(function () {
    fxAccounts.getAccountsURI();
  }, "Firefox Accounts server must use HTTPS");

  Services.prefs.clearUserPref("firefox.accounts.remoteUrl");

  run_next_test();
});

add_task(function test_get_signed_in_user_initially_unset() {
  // This test, unlike the rest, uses an un-mocked FxAccounts instance.
  // However, we still need to pass an object to the constructor to
  // force it to expose "internal", so we can test the disk storage.
  let account = new FxAccounts({onlySetInternal: true})
  let credentials = {
    email: "foo@example.com",
    uid: "1234@lcip.org",
    assertion: "foobar",
    sessionToken: "dead",
    kA: "beef",
    kB: "cafe",
    isVerified: true
  };

  let result = yield account.getSignedInUser();
  do_check_eq(result, null);

  yield account.setSignedInUser(credentials);

  let result = yield account.getSignedInUser();
  do_check_eq(result.email, credentials.email);
  do_check_eq(result.assertion, credentials.assertion);
  do_check_eq(result.kB, credentials.kB);

  // Delete the memory cache and force the user
  // to be read and parsed from storage (e.g. disk via JSONStorage).
  delete account.internal.signedInUser;
  let result = yield account.getSignedInUser();
  do_check_eq(result.email, credentials.email);
  do_check_eq(result.assertion, credentials.assertion);
  do_check_eq(result.kB, credentials.kB);

  // sign out
  yield account.signOut();

  // user should be undefined after sign out
  let result = yield account.getSignedInUser();
  do_check_eq(result, null);
});


function expandHex(two_hex) {
  // Return a 64-character hex string, encoding 32 identical bytes.
  let eight_hex = two_hex + two_hex + two_hex + two_hex;
  let thirtytwo_hex = eight_hex + eight_hex + eight_hex + eight_hex;
  return thirtytwo_hex + thirtytwo_hex;
};

function expandBytes(two_hex) {
  return CommonUtils.hexToBytes(expandHex(two_hex));
};

let Storage = function() {
  this.data = null;
};
Storage.prototype = Object.freeze({
  set: function (contents) {
    this.data = contents;
    return Promise.resolve(null);
  },
  get: function () {
    return Promise.resolve(this.data);
  },
});

let _MockFXA = function() {
  this._d_fetchKeys = Promise.defer();
  this._getCertificateSigned_calls = [];
  this._d_signCertificate = Promise.defer();
  this._now_is = new Date();

  let mockInternal = {
    signedInUserStorage: new Storage(),
    now: () => {
      return this._now_is;
    },
    fetchKeys: (keyFetchToken) => {
      _("mock fetchKeys\n");
      return this._d_fetchKeys.promise;
    },
    checkEmailStatus: (sessionToken) => {
      _("mock checkEmailStatus\n");
      if (this._check_count) {
        return Promise.resolve({verified: true});
      }
      this._check_count = true;
      return Promise.resolve({verified: false});
    },
    getCertificateSigned: (sessionToken, serializedPublicKey) => {
      _("mock getCerificateSigned\n");
      this._getCertificateSigned_calls.push([sessionToken, serializedPublicKey]);
      return this._d_signCertificate.promise;
    },
  };
  FxAccounts.apply(this, [mockInternal]);
};
_MockFXA.prototype = {
  __proto__: FxAccounts.prototype,
};

add_task(function test_verification_poll() {
  let a = new _MockFXA();
  let creds = {
    sessionToken: "sessionToken",
    keyFetchToken: "keyFetchToken",
    unwrapBKey: expandHex("44"),
  };
  yield a.setSignedInUser(creds);
  let data = yield a.internal.getUserAccountData();
  do_check_eq(!!data.isVerified, false);
  data = yield a.getSignedInUser();
  do_check_neq(data, null);
  data = yield a.internal.whenVerified(data);
  do_check_eq(a.internal.isUserEmailVerified(data), true);
  do_check_eq(!!data.isVerified, true);
});

add_task(function test_getKeys() {
  let a = new _MockFXA();
  let creds = {
    sessionToken: "sessionToken",
    keyFetchToken: "keyFetchToken",
    unwrapBKey: expandHex("44"),
    isVerified: true,
  };
  a._d_fetchKeys.resolve({
    kA: expandBytes("11"),
    wrapKB: expandBytes("22"),
  });

  yield a.setSignedInUser(creds);
  yield a.getKeys();
  let data = yield a.getSignedInUser();

  do_check_eq(a.internal.isUserEmailVerified(data), true);
  do_check_eq(!!data.isVerified, true);
  do_check_eq(data.kA, expandHex("11"));
  do_check_eq(data.kB, expandHex("66"));
  do_check_eq(data.keyFetchToken, undefined);
});

add_task(function test_getAssertion() {
  let a = new _MockFXA();

  let noData = yield a.getAssertion("nonaudience");
  do_check_eq(noData, null);

  let creds = {
    sessionToken: "sessionToken",
    kA: expandHex("11"),
    kB: expandHex("66"),
    isVerified: true,
  };
  // By putting kA/kB/isVerified in "creds", we skip ahead
  // to the "we're ready" stage.
  yield a.setSignedInUser(creds);

  _("== ready to go\n");
  let now = 138000000*1000;
  let start = Date.now();
  a._now_is = now;
  let d = a.getAssertion("audience.example.com");
  // At this point, a thread has been spawned to generate the keys.
  _("-- back from a.getAssertion\n");
  a._d_signCertificate.resolve("cert1");
  let assertion = yield d;
  let finish = Date.now();
  do_check_eq(a._getCertificateSigned_calls.length, 1);
  do_check_eq(a._getCertificateSigned_calls[0][0], "sessionToken");
  do_check_neq(assertion, null);
  _("ASSERTION: "+assertion+"\n");
  let pieces = assertion.split("~");
  do_check_eq(pieces[0], "cert1");
  do_check_neq(a.internal.keyPair, undefined);
  _(a.internal.keyPair.validUntil+"\n");
  let p2 = pieces[1].split(".");
  let header = JSON.parse(atob(p2[0]));
  _("HEADER: "+JSON.stringify(header)+"\n");
  do_check_eq(header.alg, "DS128");
  let payload = JSON.parse(atob(p2[1]));
  _("PAYLOAD: "+JSON.stringify(payload)+"\n");
  do_check_eq(payload.aud, "audience.example.com");
  // FxAccounts KEY_LIFETIME
  do_check_eq(a.internal.keyPair.validUntil, now + (12*3600*1000));
  // FxAccounts CERT_LIFETIME
  do_check_eq(a.internal.cert.validUntil, now + (6*3600*1000));
  _("delta: "+(new Date(payload.exp) - now)+"\n");
  let exp = Number(payload.exp);
  // jwcrypto.jsm uses an unmocked Date.now()+2min to decide on the
  // expiration time, so we test that it's inside a specific timebox
  do_check_true(start + 2*60*1000 <= exp);
  do_check_true(exp <= finish + 2*60*1000);

  // Reset for next call.
  a._d_signCertificate = Promise.defer();

  // Getting a new assertion "soon" (i.e. w/o incrementing "now"), even for
  // a new audience, should not provoke key generation or a signing request.
  assertion = yield a.getAssertion("other.example.com");
  do_check_eq(a._getCertificateSigned_calls.length, 1);

  // But "waiting" (i.e. incrementing "now") will need a new key+signature.
  a._now_is = now + 24*3600*1000;
  start = Date.now();
  d = a.getAssertion("third.example.com");
  a._d_signCertificate.resolve("cert2");
  assertion = yield d;
  finish = Date.now();
  do_check_eq(a._getCertificateSigned_calls.length, 2);
  do_check_eq(a._getCertificateSigned_calls[1][0], "sessionToken");
  pieces = assertion.split("~");
  do_check_eq(pieces[0], "cert2");
  p2 = pieces[1].split(".");
  header = JSON.parse(atob(p2[0]));
  payload = JSON.parse(atob(p2[1]));
  do_check_eq(payload.aud, "third.example.com");
  // 12*3600*1000 === FxAccounts KEY_LIFETIME
  do_check_eq(a.internal.keyPair.validUntil, now + 24*3600*1000 + (12*3600*1000));
  // 6*3600*1000 === FxAccounts CERT_LIFETIME
  do_check_eq(a.internal.cert.validUntil, now + 24*3600*1000 + (6*3600*1000));
  exp = Number(payload.exp);
  do_check_true(start + 2*60*1000 <= exp);
  do_check_true(exp <= finish + 2*60*1000);

  _("----- DONE ----\n");
});

