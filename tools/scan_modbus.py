import minimalmodbus
import serial
import time

PORT = "/dev/ttyUSB0"

BAUDRATES = [4800, 9600, 19200, 38400]
SLAVE_IDS = range(1, 11)
FUNCTION_CODES = [3, 4]

for baudrate in BAUDRATES:
    for slave_id in SLAVE_IDS:
        for function_code in FUNCTION_CODES:
            instrument = minimalmodbus.Instrument(PORT, slave_id)
            instrument.mode = minimalmodbus.MODE_RTU

            instrument.serial.baudrate = baudrate
            instrument.serial.bytesize = 8
            instrument.serial.parity = serial.PARITY_NONE
            instrument.serial.stopbits = 1
            instrument.serial.timeout = 0.4

            instrument.clear_buffers_before_each_transaction = True
            instrument.close_port_after_each_call = True

            print(
                f"Testing baud={baudrate}, "
                f"id={slave_id}, fc={function_code}"
            )

            try:
                value = instrument.read_register(
                    registeraddress=0,
                    number_of_decimals=0,
                    functioncode=function_code,
                    signed=False,
                )

                print("RESPONSE FOUND")
                print(
                    f"baud={baudrate}, "
                    f"id={slave_id}, "
                    f"fc={function_code}, "
                    f"value={value}"
                )
                raise SystemExit

            except minimalmodbus.NoResponseError:
                pass

            except Exception as error:
                print("DEVICE RESPONDED WITH ERROR")
                print(
                    f"baud={baudrate}, "
                    f"id={slave_id}, "
                    f"fc={function_code}"
                )
                print(type(error).__name__)
                print(error)
                raise SystemExit

            time.sleep(0.05)

print("NO RESPONSE FOUND")
