#!/bin/sh


podman build -t actuallycoding/quartz .
# podman login 
podman push actuallycoding/quartz
