/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


this.EXPORTED_SYMBOLS = ["fxAccounts", "FxAccounts"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://services-crypto/utils.js");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Timer.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/FxAccountsClient.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "jwcrypto",
                                  "resource://gre/modules/identity/jwcrypto.jsm");

const DATA_FORMAT_VERSION = 1;
const DEFAULT_STORAGE_FILENAME = "signedInUser.json";
const ASSERTION_LIFETIME = 1000 * 60 * 5; // 5 minutes
const KEY_LIFETIME = 1000 * 3600 * 12;    // 12 hours
const CERT_LIFETIME = 1000 * 3600 * 6;    // 6 hours
const POLL_SESSION = 1000 * 60 * 5;       // 5 minutes
const POLL_STEP = 1000 * 3;               // 3 seconds

let log = Log.repository.getLogger("Services.FxAccounts");
log.level = Log.Level.Debug;

InternalMethods = function(mock) {
  this.cert = null;
  this.keyPair = null;
  this.pollTimeRemaining = null;
  this.signedInUser = null;
  this.version = DATA_FORMAT_VERSION;
  // These two promises only exist while we're querying the server.
  this.whenVerifiedPromise = null;
  this.whenKeysReadyPromise = null;

  this.fxAccountsClient = new FxAccountsClient();

  if (mock) { // Testing.
    Object.keys(mock).forEach((prop) => {
      log.debug('InternalMethods: mocking: '+ prop);
      this[prop] = mock[prop];
    });
  }
  if (!this.signedInUserStorage) {
    // Normal initialization.
    // We don't reference |profileDir| in the top-level module scope
    // as we may be imported before we know where it is.
    this.signedInUserStorage = new JSONStorage({
      filename: DEFAULT_STORAGE_FILENAME,
      baseDir: OS.Constants.Path.profileDir,
    });
  }
}
InternalMethods.prototype = {

  checkEmailStatus: function checkEmailStatus(sessionToken) {
    return this.fxAccountsClient.recoveryEmailStatus(sessionToken);
  },

  fetchKeys: function fetchKeys(keyFetchToken) {
    return this.fxAccountsClient.accountKeys(keyFetchToken);
  },

  fetchAndUnwrapKeys: function(keyFetchToken) {
    log.debug("== fetchAndUnwrapKeys");
    return Task.spawn(function task() {
      // Sign out if we don't have a key fetch token.
      if (!keyFetchToken) {
        yield internal.signOut();
        return;
      }

      let {kA, wrapKB} = yield internal.fetchKeys(keyFetchToken);

      let data = yield internal.getUserAccountData();
      let kB_hex = CryptoUtils.xor(CommonUtils.hexToBytes(data.unwrapBKey),
                                   wrapKB);
      data.kA = CommonUtils.bytesAsHex(kA); // store kA/kB as hex
      data.kB = CommonUtils.bytesAsHex(kB_hex);
      delete data.keyFetchToken;
      log.debug("Keys Obtained: kA=" + data.kA + ", kB=" + data.kB);
      yield internal.setUserAccountData(data);
      // We are now ready for business. This should only be invoked once
      // per setSignedInUser(), regardless of whether we've rebooted since
      // setSignedInUser() was called.
      yield data;
    }.bind(this));
  },

  getAssertionFromCert: function(data, keyPair, cert, audience) {
    log.debug("getAssertionFromCert");
    let payload = {};
    let d = Promise.defer();
    // "audience" should look like "http://123done.org".
    // The generated assertion will expire in two minutes.
    jwcrypto.generateAssertion(cert, keyPair, audience, function(err, signed) {
      if (err) {
        d.reject(err);
      } else {
        log.debug("getAssertionFromCert returning signed: " + signed);
        d.resolve(signed);
      }
    });
    return d.promise;
  },

  getCertificate: function(data, keyPair, mustBeValidUntil) {
    log.debug("getCertificate " + internal.signedInUserStorage);
    // TODO: get the lifetime from the cert's .exp field
    if (internal.cert && internal.cert.validUntil > mustBeValidUntil) {
      log.debug(" getCertificate already had one");
      return Promise.resolve(internal.cert.cert);
    }
    // else get our cert signed
    let willBeValidUntil = internal.now() + CERT_LIFETIME;
    return internal.getCertificateSigned(data.sessionToken,
                                         keyPair.serializedPublicKey,
                                         CERT_LIFETIME)
      .then((cert) => {internal.cert = {cert: cert,
                       validUntil: willBeValidUntil};
        return cert;
      });
  },

  getCertificateSigned: function(sessionToken, serializedPublicKey, lifetime) {
    log.debug("getCertificateSigned: " + sessionToken + " " + serializedPublicKey);
    return this.fxAccountsClient.signCertificate(sessionToken,
                                                 JSON.parse(serializedPublicKey),
                                                 lifetime);
  },

  getKeyPair: function(mustBeValidUntil) {
    log.debug("getKeyPair");
    if (internal.keyPair) {
      log.debug(" " + internal.keyPair.validUntil + " " + mustBeValidUntil);
    }
    if (internal.keyPair && (internal.keyPair.validUntil > mustBeValidUntil)) {
      log.debug(" getKeyPair already had one");
      return Promise.resolve(internal.keyPair.keyPair);
    }
    // Otherwse, create a keypair and set validity limit.
    let willBeValidUntil = internal.now() + KEY_LIFETIME;
    let d = Promise.defer();
    jwcrypto.generateKeyPair("DS160", (err, kp) => {
      if (err) {
        d.reject(err);
      } else {
        log.debug(" getKeyPair got keypair");
        internal.keyPair = { keyPair: kp,
                          validUntil: willBeValidUntil };
        delete internal.cert;
        d.resolve(internal.keyPair.keyPair);
      }
    });
    return d.promise;
  },

  getUserAccountData: function() {
    // Skip disk if user is cached.
    if (internal.signedInUser) {
      return Promise.resolve(internal.signedInUser.accountData);
    }

    let deferred = Promise.defer();
    internal.signedInUserStorage.get()
      .then((user) => {
        if (user && user.version == this.version) {
          internal.signedInUser = user;
        }
        deferred.resolve(user ? user.accountData : undefined);
      },
      (err) => {deferred.resolve(undefined)}
      );

    return deferred.promise;
  },

  isUserEmailVerified: function isUserEmailVerified(data) {
    return !!(data && data.isVerified);
  },

  /**
   * Setup for and if necessary do email verification polling.
   */
  loadAndPoll: function() {
    internal.getUserAccountData()
      .then(data => {
        if (data && !internal.isUserEmailVerified(data)) {
          return internal.startVerifiedCheck(data);
        }
        return data;
      });
  },

  notifyObservers: function(topic) {
    Services.obs.notifyObservers(null, topic, null);
  },

  /**
   * Give xpcshell tests an override point for duration testing.
   */
  now: function() {
    return Date.now();
  },

  pollEmailStatus: function pollEmailStatus(sessionToken, why) {
    log.debug(" entering pollEmailStatus (" + (why||"") + ")");
    internal.checkEmailStatus(sessionToken)
      .then((response) => {
        log.debug(" - response: " + response);
        if (response && response.verified) {
          internal.getUserAccountData()
            .then((data) => {
              data.isVerified = true;
              return internal.setUserAccountData(data);
            })
            .then((data) => {
              internal.whenVerifiedPromise.resolve(data);
              delete internal.whenVerifiedPromise;
            });
        } else {
          internal.pollTimeRemaining -= POLL_STEP;
          if (internal.pollTimeRemaining > 0) {
            log.debug("-=*=- starting setTimeout()");
            setTimeout(() => {internal.pollEmailStatus(sessionToken, "timer")},
                       POLL_STEP);
          }
        }
      });
    },

  setUserAccountData: function(accountData) {
    return internal.signedInUserStorage.get().then((record) => {
      record.accountData = accountData;
      internal.signedInUser = record;
      return internal.signedInUserStorage.set(record)
               .then(() => {return accountData});
    });
  },

  startVerifiedCheck: function(data) {
    // Get us to the verified state, then get the keys. This returns a
    // promise that will fire when we are completely ready.
    return internal.whenVerified(data)
      .then(() => {
	 internal.notifyObservers("fxaccounts:onlogin");
         return data;
      });
  },

  whenVerified: function(data) {
    if (data.isVerified) {
      return Promise.resolve(data);
    }
    if (!internal.whenVerifiedPromise) {
      internal.pollTimeRemaining = POLL_SESSION;
      internal.whenVerifiedPromise = Promise.defer();
      internal.pollEmailStatus(data.sessionToken, "start");
    }
    return internal.whenVerifiedPromise.promise;
  },

};
let internal = null;
/**
 * FxAccounts delegates private methods to an instance of InternalMethods,
 * which is not exported. The xpcshell tests need two overrides:
 *  1) Access to the real internal.signedInUserStorage.
 *  2) The ability to mock InternalMethods.
 * If mockInternal is undefined, we are live.
 * If mockInternal.onlySetInternal is present, we are executing the first
 * case by binding internal to the FxAccounts instance.
 * Otherwise if we have a mock instance, we are executing the second case.
 */
this.FxAccounts = function(mockInternal) {
  let mocks = mockInternal;
  if (mocks && mocks.onlySetInternal) {
    mocks = null;
  }
  internal = new InternalMethods(mocks);
  if (mockInternal) { // not mocks
    this.internal = internal;
  }
}
this.FxAccounts.prototype = Object.freeze({
  version: DATA_FORMAT_VERSION,

  // set() makes sure that polling is happening, if necessary.
  // get() does not wait for verification, and returns an object even if
  // unverified. The caller of get() must check .isVerified .
  // The "fxaccounts:onlogin" event will fire only when the verified state
  // goes from false to true, so callers must register their observer
  // and then call get(). In particular, it will not fire when the account
  // was found to be verified in a previous boot: if our stored state says
  // the account is verified, the event will never fire. So callers must do:
  //   register notification observer (go)
  //   userdata = get()
  //   if (userdata.isVerified()) {go()}

  /**
   * Set the current user signed in to Firefox Accounts.
   *
   * @param credentials
   *        The credentials object obtained by logging in or creating
   *        an account on the FxA server:
   *        {
   *          email: The users email address
   *          uid: The user's unique id
   *          sessionToken: Session for the FxA server
   *          keyFetchToken: an unused keyFetchToken
   *          isVerified: true/false
   *        }
   * @return Promise
   *         The promise resolves to null when the data is saved
   *         successfully and is rejected on error.
   */
  setSignedInUser: function setSignedInUser(credentials) {
    internal.loadAndPoll();
    let record = {version: this.version, accountData: credentials };
    // Cache a clone of the credentials object.
    internal.signedInUser = JSON.parse(JSON.stringify(record));

    // This promise waits for storage, but not for verification.
    return internal.signedInUserStorage.set(record)
      .then(() => {
        if (!internal.isUserEmailVerified(credentials)) {
          internal.startVerifiedCheck(credentials);
        }
      });
  },

  /**
   * Fetch encryption keys for the signed-in-user from the FxA API server.
   *
   * @return Promise
   *        The promise resolves to the credentials object of the signed-in user:
   *        {
   *          email: The user's email address
   *          uid: The user's unique id
   *          sessionToken: Session for the FxA server
   *          kA: An encryption key from the FxA server
   *          kB: An encryption key derived from the user's FxA password
   *          isVerified: email verification status
   *        }
   *        or null if no user is signed in
   */
  getKeys: function() {
    return internal.getUserAccountData().then((data) => {
      if (data.kA && data.kB) {
        return Promise.resolve(data);
      }
      if (!internal.whenKeysReadyPromise) {
        internal.whenKeysReadyPromise = Promise.defer();
        internal.fetchAndUnwrapKeys(data.keyFetchToken)
          .then((data) => {
            internal.whenKeysReadyPromise.resolve(data);
          });
      }
      return internal.whenKeysReadyPromise.promise;
      });
   },

  /**
   * Get the user currently signed in to Firefox Accounts.
   *
   * @return Promise
   *        The promise resolves to the credentials object of the signed-in user:
   *        {
   *          email: The user's email address
   *          uid: The user's unique id
   *          sessionToken: Session for the FxA server
   *          kA: An encryption key from the FxA server
   *          kB: An encryption key derived from the user's FxA password
   *          isVerified: email verification status
   *        }
   *        or null if no user is signed in.
   */
  getSignedInUser: function getSignedInUser() {
    internal.loadAndPoll();
    return internal.getUserAccountData()
      .then((data) => {
        if (!data) {
          return null;
        }
        if (!internal.isUserEmailVerified(data)) {
          internal.startVerifiedCheck(data);
        }
        return data;
      });
  },

  /**
   * Return a BrowserID-compatible (?) assertion for use by RPs.
   */
  getAssertion: function getAssertion(audience) {
    log.debug("--- getAssertion() starts");
    let mustBeValidUntil = internal.now() + ASSERTION_LIFETIME;
    return internal.getUserAccountData()
      .then((data) => {
        if (!internal.isUserEmailVerified(data)) {
          return null;
        }
        return internal.getKeyPair(mustBeValidUntil)
          .then((keyPair) => {
            return internal.getCertificate(data, keyPair, mustBeValidUntil)
              .then((cert) => {
                return internal.getAssertionFromCert(data, keyPair,
                                                     cert, audience)
              });
          });
      });
  },

  /**
   * Sign the current user out.
   *
   * @return Promise
   *         The promise is rejected if a storage error occurs.
   */
  signOut: function signOut() {
    internal.signedInUser = null;
    return internal.signedInUserStorage.set(null).then(() => {
      internal.notifyObservers("fxaccounts:onlogout");
    });
  },

  // Return the URI of the remote UI flows.
  getAccountsURI: function() {
    let url = Services.urlFormatter.formatURLPref("firefox.accounts.remoteUrl");
    if (!/^https:/.test(url)) { // Comment to un-break emacs js-mode highlighting
      throw new Error("Firefox Accounts server must use HTTPS");
    }
    return url;
  },
});

/**
 * JSONStorage constructor that creates instances that may set/get
 * to a specified file, in a directory that will be created if it
 * doesn't exist.
 *
 * @param options {
 *                  filename: of the file to write to
 *                  baseDir: directory where the file resides
 *                }
 * @return instance
 */
function JSONStorage(options) {
  this.baseDir = options.baseDir;
  this.path = OS.Path.join(options.baseDir, options.filename);
};

JSONStorage.prototype = {
  set: function(contents) {
    return OS.File.makeDir(this.baseDir, {ignoreExisting: true})
      .then(CommonUtils.writeJSON.bind(null, contents, this.path));
  },

  get: function() {
    return CommonUtils.readJSON(this.path);
  },
};

// A getter for the instance to export
XPCOMUtils.defineLazyGetter(this, "fxAccounts", function() {
  let a = new FxAccounts();
  internal.loadAndPoll();
  return a;
});

