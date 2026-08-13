import csv
import time
from datetime import datetime

import minimalmodbus
import serial

PORT = "/dev/ttyUSB0"
SLAVE_ID = 5
BAUDRATE = 9600

REGISTER_START = 0
REGISTER_END = 20

# Water measurements after insertion
MEASUREMENT_TIMES = [5, 15, 30, 60]

instrument = minimalmodbus.Instrument(PORT, SLAVE_ID)
instrument.mode = minimalmodbus.MODE_RTU

instrument.serial.baudrate = BAUDRATE
instrument.serial.bytesize = 8
instrument.serial.parity = serial.PARITY_NONE
instrument.serial.stopbits = 1
instrument.serial.timeout = 1.0

instrument.clear_buffers_before_each_transaction = True
instrument.close_port_after_each_call = True


def read_all_registers():
    values = []

    for address in range(REGISTER_START, REGISTER_END + 1):
        value = instrument.read_register(
            registeraddress=address,
            number_of_decimals=0,
            functioncode=3,
            signed=False
        )

        values.append(value)
        time.sleep(0.03)

    return values


def wait_until(target_seconds, start_time):
    while True:
        elapsed = time.time() - start_time
        remaining = target_seconds - elapsed

        if remaining <= 0:
            break

        time.sleep(min(0.2, remaining))


def trend_text(values):
    differences = [
        values[index + 1] - values[index]
        for index in range(len(values) - 1)
    ]

    if all(change == 0 for change in differences):
        return "STATIC"

    if all(change >= 0 for change in differences):
        return "UP"

    if all(change <= 0 for change in differences):
        return "DOWN"

    return "FLUCTUATING"


def change_marker(change, value_range):
    if abs(change) >= 50 or value_range >= 50:
        return "***"

    if abs(change) >= 10 or value_range >= 10:
        return "**"

    if abs(change) >= 2 or value_range >= 2:
        return "*"

    return ""


try:
    print()
    print("======================================================")
    print("       DEC890 FC03 AIR-TAP WATER ANALYSIS")
    print("======================================================")
    print("Step 1: Keep the sensor in AIR.")
    input("Press Enter to measure AIR: ")

    air_values = read_all_registers()

    print()
    print("AIR measurement complete.")
    print("Step 2: Put the sensing part into TAP WATER.")
    input("Press Enter immediately after insertion: ")

    water_start_time = time.time()
    measurements = {
        "AIR": air_values
    }

    for target_time in MEASUREMENT_TIMES:
        wait_until(target_time, water_start_time)

        print(f"Reading TAP WATER at {target_time} seconds...")
        measurements[f"WATER_{target_time}s"] = read_all_registers()

    print()
    print("==========================================================================")
    print("Reg |   AIR |    5s |   15s |   30s |   60s | Delta | Range | Trend")
    print("==========================================================================")

    rows = []

    for address in range(REGISTER_START, REGISTER_END + 1):
        sequence = [
            measurements["AIR"][address],
            measurements["WATER_5s"][address],
            measurements["WATER_15s"][address],
            measurements["WATER_30s"][address],
            measurements["WATER_60s"][address]
        ]

        final_change = sequence[-1] - sequence[0]
        value_range = max(sequence) - min(sequence)
        trend = trend_text(sequence)
        marker = change_marker(final_change, value_range)

        print(
            f"R{address:02d} | "
            f"{sequence[0]:5d} | "
            f"{sequence[1]:5d} | "
            f"{sequence[2]:5d} | "
            f"{sequence[3]:5d} | "
            f"{sequence[4]:5d} | "
            f"{final_change:+5d} | "
            f"{value_range:5d} | "
            f"{trend:11s} {marker}"
        )

        rows.append([
            address,
            sequence[0],
            sequence[1],
            sequence[2],
            sequence[3],
            sequence[4],
            final_change,
            value_range,
            trend,
            marker
        ])

    print("==========================================================================")
    print("*   : small but visible change")
    print("**  : noticeable change")
    print("*** : large change")
    print("Communication: OK")
    print("==========================================================================")

    filename = (
        "dec890_air_tapwater_"
        + datetime.now().strftime("%Y%m%d_%H%M%S")
        + ".csv"
    )

    with open(filename, "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)

        writer.writerow([
            "register",
            "air",
            "water_5s",
            "water_15s",
            "water_30s",
            "water_60s",
            "delta_air_to_60s",
            "range",
            "trend",
            "change_marker"
        ])

        writer.writerows(rows)

    print()
    print(f"CSV saved: {filename}")
    print()

except Exception as error:
    print()
    print("Communication: ERROR")
    print(f"Error Type   : {type(error).__name__}")
    print(f"Error Message: {error}")

finally:
    if instrument.serial.is_open:
        instrument.serial.close()
