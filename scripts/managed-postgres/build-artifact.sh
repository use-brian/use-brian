#!/bin/sh
# [COMP:platform/managed-postgres] Source recipe for the managed local
# PostgreSQL artifact (PostgreSQL 18.7 + pgvector 0.8.7, macOS 13+ arm64).
# Spec: docs/architecture/platform/database-schema.md → "Managed local
# PostgreSQL runtime".
#
#   scripts/managed-postgres/build-artifact.sh WORK_DIR OUT_DIR
#
# Downloads (or reuses) the pinned upstream tarballs, verifies their SHA-256,
# builds with the system toolchain only, and hands the install tree to
# assemble-artifact.mjs, which relocates it, compiles the lifecycle executor,
# adds licenses and writes the manifest. The printed manifest SHA-256 is what
# a release pins in packages/api/src/db/managed-postgres/release.ts.
# The artifact is a release input; never commit it.
set -eu

WORK=${1:?usage: build-artifact.sh WORK_DIR OUT_DIR}
OUT=${2:?usage: build-artifact.sh WORK_DIR OUT_DIR}
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node)

PG_VERSION=18.7
PG_URL=https://ftp.postgresql.org/pub/source/v18.7/postgresql-18.7.tar.bz2
PG_SHA256=441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd
VECTOR_VERSION=0.8.7
VECTOR_URL=https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz
VECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876
VECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85

if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  echo "build-artifact.sh: only darwin-arm64 is qualified; Windows and Linux have no release pin" >&2
  exit 64
fi
case "$WORK" in /*) ;; *) echo "WORK_DIR must be absolute" >&2; exit 64 ;; esac
case "$OUT" in /*) ;; *) echo "OUT_DIR must be absolute" >&2; exit 64 ;; esac
[ ! -e "$OUT" ] || { echo "OUT_DIR must not exist: $OUT" >&2; exit 64; }

export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export CC=/usr/bin/clang CXX=/usr/bin/clang++
export MACOSX_DEPLOYMENT_TARGET=13.0
export CFLAGS=-O2 LDFLAGS=-Wl,-headerpad_max_install_names
unset PG_CONFIG PGDATA PGHOST PGPORT PGOPTIONS 2>/dev/null || true

mkdir -p "$WORK"
cd "$WORK"
fetch() {
  [ -f "$2" ] || /usr/bin/curl -fsSL -o "$2" "$1"
  echo "$3  $2" | /usr/bin/shasum -a 256 -c -
}
fetch "$PG_URL" "postgresql-$PG_VERSION.tar.bz2" "$PG_SHA256"
fetch "$VECTOR_URL" "pgvector-$VECTOR_VERSION.tar.gz" "$VECTOR_SHA256"

rm -rf "postgresql-$PG_VERSION" "pgvector-$VECTOR_VERSION" install
/usr/bin/tar -xjf "postgresql-$PG_VERSION.tar.bz2"
/usr/bin/tar -xzf "pgvector-$VECTOR_VERSION.tar.gz"

cd "$WORK/postgresql-$PG_VERSION"
./configure --prefix="$WORK/install" --without-icu --without-readline --without-zlib --disable-nls
make -j4
make install
make -C contrib/pg_trgm -j4
make -C contrib/pg_trgm install

cd "$WORK/pgvector-$VECTOR_VERSION"
make -j4 PG_CONFIG="$WORK/install/bin/pg_config" OPTFLAGS=
make install PG_CONFIG="$WORK/install/bin/pg_config" OPTFLAGS=

mkdir -p "$WORK/install/share/licenses/postgresql" "$WORK/install/share/licenses/pgvector"
cp "$WORK/postgresql-$PG_VERSION/COPYRIGHT" "$WORK/install/share/licenses/postgresql/COPYRIGHT"
cp "$WORK/pgvector-$VECTOR_VERSION/LICENSE" "$WORK/install/share/licenses/pgvector/LICENSE"

"$NODE" "$HERE/assemble-artifact.mjs" --install "$WORK/install" --out "$OUT" --vector-commit "$VECTOR_COMMIT"
