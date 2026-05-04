APP_NAME := aikan-axum
CARGO := cargo
WEB_DIR := web
DIST_DIR := dist
TARGET_DIR := target

ifeq ($(OS),Windows_NT)
CARGO := rustup run stable-x86_64-pc-windows-msvc cargo
EXE_SUFFIX := .exe
MKDIR_P = if not exist "$(subst /,\,$(1))" mkdir "$(subst /,\,$(1))"
COPY_BIN = copy /Y "$(subst /,\,$(1))" "$(subst /,\,$(2))"
RM_RF = if exist "$(subst /,\,$(1))" rmdir /S /Q "$(subst /,\,$(1))"
else
EXE_SUFFIX :=
MKDIR_P = mkdir -p "$(1)"
COPY_BIN = cp "$(1)" "$(2)"
RM_RF = rm -rf "$(1)"
endif

.PHONY: web build run dist clean build-linux build-windows build-macos

web:
	cd $(WEB_DIR) && bun run build

build: web
	$(CARGO) build --release

run: web
	$(CARGO) run

dist: build
	$(call MKDIR_P,$(DIST_DIR))
	$(call COPY_BIN,$(TARGET_DIR)/release/$(APP_NAME)$(EXE_SUFFIX),$(DIST_DIR)/$(APP_NAME)$(EXE_SUFFIX))

build-linux: web
	$(CARGO) build --release --target x86_64-unknown-linux-gnu

build-windows: web
	$(CARGO) build --release --target x86_64-pc-windows-msvc

build-macos: web
	$(CARGO) build --release --target x86_64-apple-darwin
	$(CARGO) build --release --target aarch64-apple-darwin

clean:
	$(call RM_RF,$(DIST_DIR))
	$(CARGO) clean
