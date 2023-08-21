#include "devsec.h"

std::string DevSec::intToHexString(int intValue) {
    std::string hexStr;
    std::stringstream sstream;
    sstream << std::setfill ('0') << std::setw(2)
    << std::hex << (int)intValue;
    hexStr = sstream.str();
    sstream.clear();
    return hexStr;
}

DevSec::DevSec() {
  this->dsig_created = false;
  this->dsig_valid = false;
  this->debug = false; // never in production, affects output(!)
  this->ssid[32] = {0};
  this->password[32] = {0};
}

void DevSec::setDebug(bool val) {
  this->debug = val;
}

void DevSec::set_credentials(char * ssid, char * pass) {

  if (!this->dsig_created) {
    printf("ERROR: No DSIG/EKEY generated to encrypt with.\n");
    return;
  }

  char *crypted_ssid = encrypt((uint8_t*)ssid);
  sprintf(this->ssid, "%s", crypted_ssid);
  char *crypted_pass = encrypt((uint8_t*)pass);
  sprintf(this->password, "%s", crypted_pass);
}

void DevSec::generate_signature(char *mac, char *ckey, char* fcid) {

  if (this->debug) printf("\n[DevSec] Generating device signature...\n");

  unsigned int mac_len = strlen(mac);

  if (mac_len > 17) {
    printf("Invalid MAC length.\n");
    exit(2);
  }

  char mac_bytes[13] = {0};
  unsigned int index = 0;
  for (unsigned int pos = 0; index < 13; pos++) {
    if ((char)mac[pos] == ':') {
      continue;
    }
    mac_bytes[index] = (unsigned int)mac[pos];
    index++;
  }

  if (index < 12) {
    printf("Invalid MAC length.\n");
    exit(2);
  }

  mac_bytes[12] = 0;

  // TODO: should actually take only last 6 bytes from MAC and 6 bytes of FCID!
  snprintf((char*)this->dsig, 21, "%s;%s;%s", SIGBASE, mac_bytes, fcid);

  if (this->debug) { printf("\nDSIG: '"); printf("%s", (char*)this->dsig); printf("'\n"); }

  this->dsig[sizeof(this->dsig)-1] = 0; // make sure there is a termination character at the end of DSIG

  this->dsig_created = true;

  for( int c = 0; c < strlen(ckey); c++) {
    this->key[c] = ckey[c] ^ fcid[c%strlen(fcid)];
    if (this->debug) { printf("0x"); printf("%s", intToHexString((int)this->key[c]).c_str()); }
    if (c < strlen(ckey) - 1) {
      if (this->debug) printf(", ");
    }
  }

  if (this->debug) printf("'\n");
}

char * DevSec::signature() {
  return (char*)this->dsig;
}

char * DevSec::unsignature(char *ckey) {
  for( int c = 0; c < strlen(this->dsig); c++) {
    this->usig[c] = ckey[c] ^ this->dsig[c];
    if (this->debug) { printf("0x"); printf("%s", intToHexString((int)this->usig[c]).c_str()); }
    if (c < strlen(ckey) - 1) {
      if (this->debug) printf(", ");
    }
  }
  return (char*)this->usig;
}

void DevSec::print_signature(char* ssid, char* password) {

  if ((strlen(ssid) > 31) || (strlen(password) > 31)) {
    // TODO: Fixme: extend SSID and PASSWORD string arrays thoughout the ecosystem (firmwares as well) to maximum length
    printf("ERROR: Currrently unsupported ssid/password length.\n");
    exit(3);
  }

  strncpy(this->ssid, ssid, strlen(ssid));
  strncpy(this->password, password, strlen(password));

  printf("/* THIS FILE SHOULD BE AUTOGENERATED BY THiNX ON BUILD FROM thinx.yml */\n");
  printf("#ifndef __EMBEDDED_SIGNATURE__\n");
  printf("#define __EMBEDDED_SIGNATURE__\n");
  printf("#include <inttypes.h>\n"); // stdlib instead of whole Arduino's byte_t
  printf("// Obfuscated firmware signature\n");
  printf("uint8_t DevSec::EMBEDDED_SIGNATURE["); printf("%lu", 1 + strlen(this->dsig)); printf("] PROGMEM = { ");

  // Signature should have 20 bytes exactly (without padding)
  for ( unsigned int d = 0; d < strlen((char*)this->dsig); d++) {
    uint8_t encrypted = this->dsig[d] ^ (128+this->key[d]);
    printf("0x"); printf("%s", intToHexString((int)encrypted).c_str());
    if (d < strlen((char*)this->dsig) - 1) {
      printf(", ");
    } else {
      printf(", 0x0");
    }
  }

  printf(" };\n");

  uint8_t ssid_len = 1 + strlen(this->ssid);
  printf("uint8_t DevSec::EMBEDDED_SSID[%u] PROGMEM = { ", ssid_len);
  for ( unsigned int d = 0; d < strlen((char*)this->ssid); d++) {
    printf("0x"); printf("%s", intToHexString((int)this->ssid[d] ^ (128+this->key[d])).c_str());
    if (d < strlen((char*)this->ssid) - 1) {
      printf(", ");
    } else {
      printf(", 0x0");
    }
  }
  printf(" };\n");

  uint8_t pass_len = 1 + strlen(this->password);
  printf("uint8_t DevSec::EMBEDDED_PASS[%u] PROGMEM = { ", pass_len);
  for ( unsigned int d = 0; d < strlen((char*)this->password); d++) {
    printf("0x"); printf("%s", intToHexString((int)this->password[d] ^ (128+this->key[d])).c_str());
    if (d < strlen((char*)this->password) - 1) {
      printf(", ");
    } else {
      printf(", 0x0");
    }
  }
  printf(" };\n");

  printf("#endif // __EMBEDDED_SIGNATURE__\n");
}

bool DevSec::validate_signature(char * signature, char * ckey) {

  if (!this->dsig_created) {
    printf("ERROR: No DSIG generated to validate against.\n");
    return false;
  }

  char unsignature[64] = {0};

  bool isValid = true;
  for ( unsigned int d = 0; d < sizeof(signature); d++) {
    unsignature[d] = this->dsig[d] ^ ckey[d];
    if (signature[d] != unsignature[d]) {
#ifdef DEBUG
      printf("\nByte "); printf("%u", d); printf(" mismatch.\n"); // debug
      printf("At: "); printf("%c", signature[d]); printf(" "); printf("%c\n", unsignature[d]); // debug
      printf("\n");
#endif
      isValid = false;
    }
    // TODO: Fix this, length may differ.
    if (d == 17) {
      break; // compares only first 17!
    }
  }

  this->dsig_valid = isValid;

  return isValid;

}

/* Performs simple symetric XOR encryption using static CKEY so does not work with strings well */

// FIXME: use pass-by-reference to get rid of internal buffer leak
char * DevSec::encrypt(uint8_t input[]) {
    if (strlen((char*)input) > 255) {
      printf("ERROR: Block too long!");
    } else {
      // dsig is valid when key is generated, this needs the key
      if (this->dsig_valid) {
        for ( unsigned int d = 0; d < strlen((char*)input); ++d ) {
          this->crypted[d] = (char)input[d] ^ (128+this->key[d]);
        }
      } else {
        printf("ERROR: DSIG must be valid for decryption.\n");
        exit(2);
      }
    }
    this->crypted[strlen((char*)input)] = 0; // adds null termination; does not solve zero collisions!
    return (char*) this->crypted;
}

// FIXME: use pass-by-reference to get rid of internal buffer leak
char * DevSec::decrypt(uint8_t input[]) {
    if (strlen((char*)input) > 255) {
      printf("ERROR: Block too long!");
    } else {
      // dsig is valid when key is generated, this needs the key
      if (this->dsig_valid) {
        for ( unsigned int d = 0; d < strlen((char*)input); ++d ) {
          this->crypted[d] = (char)input[d] ^ (128+this->key[d]);
        }
      } else {
        printf("ERROR: DSIG must be valid for decryption.\n");
        exit(2);
      }
    }
    this->crypted[strlen((char*)input)] = 0; // adds null termination; does not solve zero collisions!
    return (char*) this->crypted;
}

/* Overwrites unconditionally the dsig value with zeros */
void DevSec::cleanup() {
  if (this->dsig_created) {
    printf("Note: DSIG is being erased now...\n");
  }
  for ( unsigned int e = 0; e < sizeof(dsig); ++e ) {
    dsig[e] = 0; // zero-out in-memory signature
  }
  dsig_created = false;
  dsig_valid = false;
}
