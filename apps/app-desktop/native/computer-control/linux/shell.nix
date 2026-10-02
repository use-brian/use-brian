# Pinned development/integration closure; release packaging still needs its own audit.
{ pkgs ? import (builtins.getFlake "github:NixOS/nixpkgs/b6c8664de9b6cc07fe5666a29f91884ba81197c4").outPath {} }:
let
  python = pkgs.python3.withPackages (p: [ p.pyatspi p.pygobject3 p.pycairo ]);
in pkgs.mkShell {
  NIX_BUILD_SHELL = "${pkgs.bash}/bin/bash";
  packages = [ python pkgs.gtk3 pkgs.at-spi2-core pkgs.dbus pkgs.xorg-server pkgs.openbox pkgs.gedit ];
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.libx11 pkgs.libxi pkgs.libxrandr pkgs.libxtst ];
  GI_TYPELIB_PATH = pkgs.lib.makeSearchPath "lib/girepository-1.0" [ pkgs.gobject-introspection pkgs.gtk3 pkgs.at-spi2-core (pkgs.lib.getLib pkgs.pango) (pkgs.lib.getLib pkgs.gdk-pixbuf) (pkgs.lib.getLib pkgs.harfbuzz) ];
  XDG_DATA_DIRS = pkgs.lib.makeSearchPath "share" [ pkgs.at-spi2-core pkgs.gtk3 pkgs.gsettings-desktop-schemas ];
  DBUS_TEST_CONFIG = "${pkgs.dbus}/share/dbus-1/session.conf";
  FONTCONFIG_FILE = "${pkgs.fontconfig.out}/etc/fonts/fonts.conf";
  NO_AT_BRIDGE = "0";
}
