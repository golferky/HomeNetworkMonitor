import requests
import datetime

# your Atomi light API endpoint (example placeholder)
LIGHT_API = "http://192.168.1.39/set"

holiday_colors = {
    "St. Patrick's Day": "green",
    "Independence Day": "red_white_blue",
    "Christmas Day": "red_green",
    "Halloween": "orange",
    "Valentine's Day": "pink"
}

def set_lights(color):
    print("Setting lights to:", color)
    requests.post(LIGHT_API, json={"color": color})

today = datetime.date.today()

url = f"https://date.nager.at/api/v3/PublicHolidays/{today.year}/US"
holidays = requests.get(url).json()

for h in holidays:
    if h["date"] == str(today):
        name = h["localName"]

        if name in holiday_colors:
            set_lights(holiday_colors[name])
            break