#!/bin/bash

if pgrep -x "gammastep" > /dev/null
then
  # Nightlight is on
  echo '{"text":"", "tooltip":"Night Light: On (4500K)", "class":"on"}'
else
  # Nightlight is off
  echo '{"text":"", "tooltip":"Night Light: Off", "class":"off"}'
fi
