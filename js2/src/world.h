/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * The contents of this file are subject to the Netscape Public
 * License Version 1.1 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of
 * the License at http://www.mozilla.org/NPL/
 *
 * Software distributed under the License is distributed on an "AS
 * IS" basis, WITHOUT WARRANTY OF ANY KIND, either express or
 * implied. See the License for the specific language governing
 * rights and limitations under the License.
 *
 * The Original Code is the JavaScript 2 Prototype.
 *
 * The Initial Developer of the Original Code is Netscape
 * Communications Corporation.  Portions created by Netscape are
 * Copyright (C) 1998 Netscape Communications Corporation. All
 * Rights Reserved.
 *
 * Contributor(s): 
 *
 * Alternatively, the contents of this file may be used under the
 * terms of the GNU Public License (the "GPL"), in which case the
 * provisions of the GPL are applicable instead of those above.
 * If you wish to allow use of your version of this file only
 * under the terms of the GPL and not to allow others to use your
 * version of this file under the NPL, indicate your decision by
 * deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL.  If you do not delete
 * the provisions above, a recipient may use your version of this
 * file under either the NPL or the GPL.
 */

#ifndef world_h___
#define world_h___

#include <vector>

#include "strings.h"
#include "token.h"
#include "hash.h"

namespace JavaScript {
    
//
// String atom management
//

    // A StringAtom is a String for which the following guarantee applies:
    // StringAtoms A and B have the same character sequences if and only if A and
    // B are the same StringAtom.
    class StringAtom: public String {
      public:
        Token::Kind tokenKind;          // Token::Kind if this is a keyword; Token::identifier if not

        explicit StringAtom(const String &s): String(s), tokenKind(Token::identifier) {}
      private:
        StringAtom(const StringAtom &);     // No copy constructor
        void operator=(const StringAtom &); // No assignment operator
    };

    inline bool operator==(const StringAtom &s1, const StringAtom &s2) {return &s1 == &s2;}
    inline bool operator!=(const StringAtom &s1, const StringAtom &s2) {return &s1 != &s2;}


    class StringAtomTable {
        typedef HashTable<StringAtom, const String &> HT;
        HT ht;

      public:
        StringAtom &operator[](const String &s);
        StringAtom &operator[](const char *s) {return operator[](widenCString(s));}
    };

#ifdef DIKDIK
    namespace JS2Runtime {
        class Context;
    }
#endif

    class World {
      public:
        StringAtomTable identifiers;

        World();

#ifdef DIKDIK
        std::vector<JS2Runtime::Context *> contextList;

        /* Random number generator state, used by jsmath.c. */
        bool                rngInitialized;
        int64               rngMultiplier;
        int64               rngAddend;
        int64               rngMask;
        int64               rngSeed;
        float64             rngDscale;
#endif

    };
}
#endif
