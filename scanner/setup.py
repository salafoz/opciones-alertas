"""Preparación única: genera los iconos de la app y el par de claves VAPID para Web Push.
La clave privada queda en .secrets/ (fuera de git) y se sube como secreto de GitHub Actions."""
import base64
import struct
import zlib
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def png(size, pixel):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x / size, y / size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# Cuatro barras ascendentes dentro de la zona segura de un icono "maskable".
BARS = [(0.26, 0.6), (0.39, 0.5), (0.52, 0.41), (0.65, 0.29)]


def in_bar(x, y):
    return any(bx <= x < bx + 0.09 and top <= y < 0.72 for bx, top in BARS)


def icon(x, y):
    return (53, 211, 154, 255) if in_bar(x, y) else (11, 18, 32, 255)


def badge(x, y):
    return (255, 255, 255, 255) if in_bar(x, y) else (0, 0, 0, 0)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


(DOCS / "icon-192.png").write_bytes(png(192, icon))
(DOCS / "icon-512.png").write_bytes(png(512, icon))
(DOCS / "badge.png").write_bytes(png(96, badge))
print("Iconos generados.")

secret_file = ROOT / ".secrets" / "vapid-private.txt"
public_file = DOCS / "vapid-public.txt"
if secret_file.exists() or public_file.exists():
    # Regenerarlas invalidaría las suscripciones de los móviles ya dados de alta.
    print("Las claves VAPID ya existen: no se regeneran.")
else:
    key = ec.generate_private_key(ec.SECP256R1())
    secret_file.parent.mkdir(parents=True, exist_ok=True)
    secret_file.write_text(b64url(key.private_numbers().private_value.to_bytes(32, "big")))
    public_file.write_text(b64url(key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)) + "\n")
    print("Claves VAPID generadas.")
