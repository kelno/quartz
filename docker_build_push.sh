#!/bin/sh


podman build -t actuallycoding/quartz .
# podman login docker.io
podman push actuallycoding/quartz
