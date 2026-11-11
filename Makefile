# Makefile — 순수 JavaScript(Node.js + Browser) 프로젝트 빌드/실행/테스트
NODE ?= node
PORT ?= 8000

.PHONY: all run web test clean

all:
	$(NODE) tools/build.js

run: all
	$(NODE) server/app.js --port $(PORT)

web: all
	$(NODE) server/app.js --port $(PORT) --static

test: all
	$(NODE) tests/test_main.js
	$(NODE) tests/test_server.js

clean:
	$(NODE) tools/build.js --clean

