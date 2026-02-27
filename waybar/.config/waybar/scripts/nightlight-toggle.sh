#!/bin/bash

if pgrep -x "gammastep" > /dev/null
then
    killall gammastep
else
    gammastep -O 4500 &
fi

pkill -SIGRTMIN+8 waybar
