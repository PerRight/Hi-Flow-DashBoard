import minimalmodbus
import serial

instrument = minimalmodbus.Instrument("/dev/ttyUSB0", 5)
instrument.mode = minimalmodbus.MODE_RTU

instrument.serial.baudrate = 9600
instrument.serial.bytesize = 8
instrument.serial.parity = serial.PARITY_NONE
instrument.serial.stopbits = 1
instrument.serial.timeout = 1.0

try:
    status = instrument.read_register(
        registeraddress=0,
        number_of_decimals=0,
        functioncode=4,
        signed=False
    )

    print("FC04 SUCCESS")
    print("STATUS:", status)

except Exception as error:
    print("FC04 ERROR")
    print(type(error).__name__)
    print(error)

finally:
    if instrument.serial.is_open:
        instrument.serial.close()
