# Thin wrapper around ./wallet, which is the real task runner.
#
# `make` is not required to work on this project -- ./wallet needs only Docker.
# This file exists so `make test` behaves as expected for anyone who reaches
# for make out of habit, and so CI can call either one.

.DEFAULT_GOAL := help
.PHONY: help install install-node install-forge up dev down restart logs ps \
        test test-node test-forge typecheck fmt fmt-check psql shell \
        accounts clean nuke

help install install-node install-forge up dev down restart logs ps \
test test-node test-forge typecheck fmt fmt-check psql shell \
accounts clean nuke:
	@./wallet $@
