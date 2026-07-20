import tinytuya

d = tinytuya.BulbDevice(
    "0340863040f520312dae",
    "192.168.1.39",
    "LOCAL_KEY_HERE"
)

d.set_version(3.3)

# turn on
d.turn_on()

# set green
d.set_colour(0,255,0)