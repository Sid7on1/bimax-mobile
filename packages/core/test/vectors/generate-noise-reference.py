"""Reproduce the differential vector with noiseprotocol==0.3.1 (not Bimax code).
Run in an isolated venv with noiseprotocol==0.3.1 and cryptography==50.0.2.
The resulting vector is a reference implementation fixture, not an official Noise vector.
"""
import json
from pathlib import Path
from noise.connection import NoiseConnection, Keypair
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

protocol = "Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s"
keys = {name: bytes(range(start, start + 32)) for name, start in [
    ("init_static", 0), ("resp_static", 32), ("init_ephemeral", 64), ("resp_ephemeral", 96), ("psk", 128)
]}
prologue = b"bimax independent IKpsk0 reference v2"
i, r = NoiseConnection.from_name(protocol.encode()), NoiseConnection.from_name(protocol.encode())
i.set_as_initiator()
r.set_as_responder()
for peer, prefix in [(i, "init"), (r, "resp")]:
    peer.set_keypair_from_private_bytes(Keypair.STATIC, keys[prefix + "_static"])
    peer.set_keypair_from_private_bytes(Keypair.EPHEMERAL, keys[prefix + "_ephemeral"])
    peer.set_psks(psk=keys["psk"])
    peer.set_prologue(prologue)
i.set_keypair_from_public_bytes(Keypair.REMOTE_STATIC, X25519PrivateKey.from_private_bytes(keys["resp_static"]).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
i.start_handshake()
r.start_handshake()
p1, p2 = b"phone pairing proof", b"desktop response"
m1 = i.write_message(p1)
assert r.read_message(m1) == p1
m2 = r.write_message(p2)
assert i.read_message(m2) == p2
transport_i = i.encrypt(b"phone transport")
assert r.decrypt(transport_i) == b"phone transport"
transport_r = r.encrypt(b"desktop transport")
assert i.decrypt(transport_r) == b"desktop transport"
result = {"source": "https://github.com/plizonczyk/noiseprotocol", "reference": "noiseprotocol==0.3.1; cryptography==50.0.2", "protocol": protocol,
          **{name: key.hex() for name, key in keys.items()}, "prologue": prologue.hex(),
          "msg1_payload": p1.hex(), "msg1_ciphertext": m1.hex(), "msg2_payload": p2.hex(), "msg2_ciphertext": m2.hex(),
          "handshake_hash": i.get_handshake_hash().hex(), "transport_i": transport_i.hex(), "transport_r": transport_r.hex()}
Path(__file__).with_name("noise-ikpsk0.json").write_text(json.dumps(result, indent=2) + "\n")

# Independent product KDF fixture using the NIST encapsulation vector and Python HKDF.
import base64
import hashlib
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
nist = json.loads(Path(__file__).with_name("ML-KEM-encapDecap-FIPS203.json").read_text())["testGroups"][0]["tests"][0]
b64 = lambda value: base64.b64encode(value).decode()
rs = X25519PrivateKey.from_private_bytes(keys["resp_static"]).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
advertisement = {"app": "bimax", "relayUrl": "wss://relay.example/room/desktop", "ref": "ref-vector", "desktopDeviceId": "desktop", "desktopPublicKey": b64(rs), "cryptoVersion": 2, "suite": "PQIK_MLKEM768_IKPSK0_25519_CHACHAPOLY_BLAKE2S", "pqPrekeyId": "pq-independent-vector", "pqPrekeyHash": b64(hashlib.sha256(bytes.fromhex(nist["ek"])).digest()), "expiresAt": 4102444800000}
prologue = json.dumps({"domain": "bimax/pairing/pqik/v2", "advertisement": advertisement, "kemCiphertext": b64(bytes.fromhex(nist["c"]))}, sort_keys=True, separators=(",", ":")).encode()
psk = HKDF(algorithm=hashes.SHA256(), length=32, salt=hashlib.sha256(prologue).digest(), info=b"Noise_IKpsk0 pairing PSK").derive(bytes.fromhex(nist["k"]))
Path(__file__).with_name("pq-composition.json").write_text(json.dumps({"reference": "Python cryptography==50.0.2 HKDF; NIST ACVP encapsulation tcId=" + str(nist["tcId"]), "advertisement": advertisement, "prologueSha256": hashlib.sha256(prologue).hexdigest(), "psk": psk.hex()}, indent=2) + "\n")
