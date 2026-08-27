import minimalmodbus
import serial

PORT = "/dev/ttyUSB0"
SLAVE_ID = 5
BAUDRATE = 9600

instrument = minimalmodbus.Instrument(PORT, SLAVE_ID)
instrument.mode = minimalmodbus.MODE_RTU

instrument.serial.baudrate = BAUDRATE
instrument.serial.bytesize = 8
instrument.serial.parity = serial.PARITY_NONE
instrument.serial.stopbits = 1
instrument.serial.timeout = 0.5

instrument.clear_buffers_before_each_transaction = True
instrument.close_port_after_each_call = True

print("========================================")
print("      EC Sensor (DEC890)")
print(" Register Analysis (0 ~ 20)")
print("========================================")

for reg in range(21):
    try:
        value = instrument.read_register(
            registeraddress=reg,
            number_of_decimals=0,
            functioncode=3,
            signed=False
        )

        print(f"Register {reg:02d} : {value}")

    except Exception as e:
        print(f"Register {reg:02d} : ERROR ({type(e).__name__})")

print("========================================")
