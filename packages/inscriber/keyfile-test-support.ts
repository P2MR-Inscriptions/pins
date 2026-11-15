// SPDX-License-Identifier: Apache-2.0

/**
 * For tests only. A keyfile at the cheapest cost `openKeyfile` accepts (N = 2^14), so a test that needs a keyfile
 * does not pay for the 128 MiB, half-second stretch that `keygen` uses (N = 2^17). Nothing outside the tests imports it.
 */
import { createKeyfile, KEYFILE_LIMITS } from "./keyfile.ts";

export function fastKeyfile(passphrase: Buffer, entropy?: Uint8Array, withSale = true, recoveryEntropy?: Uint8Array): ReturnType<typeof createKeyfile> {
  return createKeyfile(passphrase, entropy, withSale, recoveryEntropy, { n: KEYFILE_LIMITS.minN });
}
