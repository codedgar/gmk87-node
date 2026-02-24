#!/usr/bin/python3
"""
A script to control the display of a Zuoya GMK87 keyboard.

This script allows uploading animated images (GIFs) or static images (PNGs)
to the keyboard's display. It handles image processing, USB communication,
and device configuration.

Copyright 2025 Jochen Eisinger

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS  AS IS  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

import argparse
import array
import datetime
import sys
import time
from PIL import Image
import usb.core
import usb.util

# USB device identifiers
VENDOR_ID = 0x320f
PRODUCT_ID = 0x5055

# Display dimensions
DISPLAY_WIDTH = 240
DISPLAY_HEIGHT = 135

# Configuration offsets
DATE_OFFSET = 35
DELAY_OFFSET = 43
FRAMES_1_OFFSET = 34
FRAMES_2_OFFSET = 46

# Default animation delay
DEFAULT_ANIMATION_DELAY_MS = 100

class Animation:
    """
    Handles the processing of image files into frames suitable for the display.

    This class opens an image or animated GIF, and processes each frame by
    resizing, cropping, and converting it to the correct format.
    """
    def __init__(self, file_path):
        """
        Initializes the Animation object and processes the image file.

        Args:
            file_path (str): The path to the image file (GIF, PNG, etc.).
        
        Raises:
            FileNotFoundError: If the specified file does not exist.
            ValueError: If the image file is invalid or contains no valid frames.
        """
        self.processed_frames = []
        try:
            with Image.open(file_path) as img:
                n_frames = getattr(img, "n_frames", 1)

                for i in range(n_frames):
                    img.seek(i)
                    frame = img.copy()
                    if frame.width == 0 or frame.height == 0:
                        print(f"Skipping frame {i} due to invalid dimensions (0x0).")
                        continue
                    
                    processed_frame = self._process_frame(frame)
                    self.processed_frames.append(processed_frame)
        except FileNotFoundError:
            print(f"Error: The file '{file_path}' was not found.", file=sys.stderr)
            raise

        if not self.processed_frames:
            raise ValueError(f"Could not process any frames from '{file_path}'.")

    def _process_frame(self, frame):
        """
        Resizes, crops, and converts a single image frame.

        Args:
            frame (PIL.Image.Image): The image frame to process.

        Returns:
            PIL.Image.Image: The processed frame in RGB format.
        """
        resized_frame = self._resize(frame)
        cropped_frame = self._crop(resized_frame)
        return cropped_frame.convert("RGB")

    def _resize(self, frame):
        """
        Resizes a frame while maintaining aspect ratio.

        The frame is resized so that it can be cropped to the display dimensions
        without distortion.

        Args:
            frame (PIL.Image.Image): The image frame to resize.

        Returns:
            PIL.Image.Image: The resized frame.
        """
        w_orig, h_orig = frame.size
        aspect_ratio = w_orig / h_orig
        
        potential_width = int(DISPLAY_HEIGHT * aspect_ratio)

        if potential_width > DISPLAY_WIDTH:
            new_size = (potential_width, DISPLAY_HEIGHT)
        else:
            new_height = int(DISPLAY_WIDTH / aspect_ratio)
            new_size = (DISPLAY_WIDTH, new_height)
            
        return frame.resize(new_size, Image.Resampling.LANCZOS)

    def _crop(self, frame):
        """
        Crops a frame to the center to match display dimensions.

        Args:
            frame (PIL.Image.Image): The image frame to crop.

        Returns:
            PIL.Image.Image: The cropped frame.
        """
        w, h = frame.size
        left = (w - DISPLAY_WIDTH) / 2
        top = (h - DISPLAY_HEIGHT) / 2
        right = (w + DISPLAY_WIDTH) / 2
        bottom = (h + DISPLAY_HEIGHT) / 2
        return frame.crop((left, top, right, bottom))

    def num_frames(self):
        """Returns the number of processed frames."""
        return len(self.processed_frames)

    def get_frame(self, idx):
        """
        Gets the pixel data for a specific frame.

        Args:
            idx (int): The index of the frame to retrieve.

        Returns:
            A sequence-like object containing the pixel data.
        """
        return self.processed_frames[idx].getdata()

class USBDevice:
    """A wrapper for pyusb to handle communication with the keyboard."""
    def __init__(self, vendor_id=VENDOR_ID, product_id=PRODUCT_ID):
        """
        Initializes the USB device.

        Args:
            vendor_id (int): The vendor ID of the USB device.
            product_id (int): The product ID of the USB device.

        Raises:
            ValueError: If the device is not found.
            IOError: If the USB endpoints cannot be found.
        """
        self.dev = usb.core.find(idVendor=vendor_id, idProduct=product_id)
        if self.dev is None:
            raise ValueError('Device not found. Make sure it is connected.')

        try:
            if self.dev.is_kernel_driver_active(3):
                self.dev.detach_kernel_driver(3)
        except usb.core.USBError as e:
            print(f"Could not detach kernel driver: {e}", file=sys.stderr)


        cfg = self.dev.get_active_configuration()
        intf = cfg[(3,0)]

        self.ep_out = usb.util.find_descriptor(
            intf,
            custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT
        )

        self.ep_in = usb.util.find_descriptor(
            intf,
            custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN
        )

        if self.ep_out is None or self.ep_in is None:
            raise IOError("Could not find USB endpoints.")

    def write(self, data):
        """
        Writes data to the USB device.

        Args:
            data (list or array.array): The data to write.
        """
        if len(data) < 64:
            data.extend([0] * (64 - len(data)))
        self.ep_out.write(data)

    def read(self, size=8):
        """
        Reads data from the USB device.

        Args:
            size (int): The number of bytes to read.

        Returns:
            array.array: The data read from the device.
        """
        return self.ep_in.read(size, timeout=50000)

    def close(self):
        """Releases the USB device interface and reattaches the kernel driver."""
        usb.util.release_interface(self.dev, 3)
        try:
            self.dev.attach_kernel_driver(3)
        except usb.core.USBError as e:
            print(f"Could not re-attach kernel driver: {e}", file=sys.stderr)


class Keyboard:
    """
    Represents the Zuoya GMK87 keyboard and handles high-level operations.
    """
    def __init__(self, usb_device):
        """
        Initializes the Keyboard object.

        Args:
            usb_device (USBDevice): An initialized USBDevice object.
        """
        self.usb = usb_device
        self.config = []
        self.config_needs_update = False

    def close(self):
        """Closes the connection to the keyboard."""
        self.usb.close()

    def send_command(self, command_id, data=[], pos=0):
        """
        Sends a command to the keyboard.

        Args:
            command_id (int): The ID of the command to send.
            data (list): The payload of the command.
            pos (int): The position/offset for the command.

        Returns:
            array.array: The response from the keyboard.
        
        Raises:
            ValueError: If command_id or data length is invalid.
        """
        if not (0 < command_id <= 0xff):
            raise ValueError("Command ID must be between 1 and 255.")
        if len(data) > 56:
            raise ValueError("Data payload cannot exceed 56 bytes.")

        # A small delay is required before command 2, likely to give the
        # device time to process the previous command.
        if command_id == 2:
            time.sleep(0.1)

        buffer = [0x00] * 64
        buffer[0] = 0x04
        buffer[3] = command_id
        buffer[4] = len(data)
        buffer[5] = pos & 0xff
        buffer[6] = (pos >> 8) & 0xff
        buffer[7] = (pos >> 16) & 0xff

        buffer[8:8+len(data)] = data

        checksum = sum(buffer[3:])
        buffer[1] = checksum & 0xff
        buffer[2] = (checksum >> 8) & 0xff

        self.usb.write(buffer)

        while True:
            response = self.usb.read()
            if response[0:3] == array.array('B', buffer[0:3]):
                return response[4:]

    def load_config(self):
        """Loads the current configuration from the keyboard."""
        self.send_command(1)

        # The purpose of this is unknown, but it is part of the protocol.
        for i in range(9):
            self.send_command(command_id=3, data=[0x00] * 4, pos=i*4)
        self.send_command(command_id=3, data=[0x00], pos=36)

        self.send_command(2)

        buffer=[]
        for i in range(12):
            buffer.extend(self.send_command(command_id=5, data=[0x00] * 4, pos=i*4))

        self.config_needs_update = False
        self.config = buffer

    def _int_to_bcd(self, n):
        """
        Converts an integer to a BCD byte.

        Args:
            n (int): The integer to convert (0-99).

        Returns:
            int: The BCD representation.
        
        Raises:
            ValueError: If the input is out of range.
        """
        if not 0 <= n <= 99:
            raise ValueError("Input for BCD conversion must be between 0 and 99")
        return (n // 10) << 4 | (n % 10)

    def set_datetime(self):
        """Sets the keyboard's date and time to the current system time."""
        if not self.config:
            self.load_config()

        now = datetime.datetime.now()
       
        self.config[DATE_OFFSET] = self._int_to_bcd(now.second)
        self.config[DATE_OFFSET + 1] = self._int_to_bcd(now.minute)
        self.config[DATE_OFFSET + 2] = self._int_to_bcd(now.hour)
        self.config[DATE_OFFSET + 3] = now.isoweekday()
        self.config[DATE_OFFSET + 4] = self._int_to_bcd(now.day)
        self.config[DATE_OFFSET + 5] = self._int_to_bcd(now.month)
        self.config[DATE_OFFSET + 6] = self._int_to_bcd(now.year - 2000)

        self.config_needs_update = True

    def set_animation_delay(self, ms):
        """
        Sets the animation delay in milliseconds.

        Args:
            ms (int): The delay in milliseconds (60-65535).
        """
        if not self.config:
            self.load_config()

        ms = max(60, min(ms, 0xffff))

        self.config[DELAY_OFFSET] = ms & 0xff
        self.config[DELAY_OFFSET + 1] = (ms >> 8) & 0xff

        self.config_needs_update = True

    def set_frame_count(self, first_count, second_count):
        """
        Sets the number of frames in the animations.

        Args:
            first_count (int): The number of frames in the 1st animation.
            second_count (int): The number of frames in the 2nd animation.
        """
        if not self.config:
            self.load_config()

        self.config[FRAMES_1_OFFSET] = first_count
        self.config[FRAMES_2_OFFSET] = second_count

        self.config_needs_update = True

    def update_config(self):
        """Writes the modified configuration back to the keyboard."""
        if not self.config_needs_update:
            return

        self.send_command(1)
        self.send_command(command_id=6, data=self.config)
        self.send_command(2)
        self.config_needs_update = False

    def encode_frame(self, frame):
        """
        Encodes a frame into RGB565 format.

        Args:
            frame: The frame data to encode.

        Returns:
            array.array: The encoded frame data.
        """
        frame_size = ((DISPLAY_WIDTH * DISPLAY_HEIGHT * 2) + 0x7fff) & ~0x7fff
        frame_buffer = array.array('B', [0x00] * frame_size)

        for idx, pixel in enumerate(frame):
           r = (pixel[0] >> 3) & 0x1F
           g = (pixel[1] >> 2) & 0x3F
           b = (pixel[2] >> 3) & 0x1F
           val = (r << 11) | (g << 5) | b
           frame_buffer[idx*2] = (val >> 8) & 0xff
           frame_buffer[idx*2+1] = val & 0xff

        return frame_buffer

    def upload_frames(self, first, second, verbose=False):
        """
        Uploads frames from two Animation objects to the keyboard.

        Args:
            first (Animation): The first animation.
            second (Animation): The second animation.
            verbose (bool): Whether to print verbose output.
        """
        if verbose:
            print("Encoding frames...")
        
        data = array.array('B', [])
        for i in range(first.num_frames()):
            data.extend(self.encode_frame(first.get_frame(i)))
        for i in range(second.num_frames()):
            data.extend(self.encode_frame(second.get_frame(i)))

        if verbose:
            print("Starting upload...")

        self.send_command(0x23)
        self.send_command(1)

        pos = 0
        total = len(data)
        last_progress = -1
        while pos < total:
            size = min(56, total - pos)
            self.send_command(command_id=0x21, data=data[pos:pos+size], pos=pos)
            pos += size
            progress = int((pos / total) * 100)
            if progress > last_progress:
                print(f"Upload progress: {progress}%", end="\r")
                last_progress = progress
        print("\nUpload complete.")

        self.send_command(2)

    def reset(self):
        """Resets the keyboard configuration to a default state."""
        self.config = bytearray.fromhex("000809020001ffffff0000000000000000000000ff000000000000ff000902ff00000155431502141025002c01000400")
        self.config_needs_update = True
        self.set_datetime()
        self.set_animation_delay(DEFAULT_ANIMATION_DELAY_MS)
        self.set_frame_count(0, 0)
        self.update_config()
        self.send_command(0x23)
        self.send_command(1)
        self.send_command(2)
        print("Keyboard reset to default configuration.")


def main():
    """The main entry point of the script."""
    parser = argparse.ArgumentParser(
        description="A tool to manage the display on the Zuoya GMK87 keyboard.",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "first",
        nargs='?',
        help="The path to the 1st animated image file (e.g., 'animation.gif')."
    )
    parser.add_argument(
        "second",
        nargs='?',
        help="The path to the 2nd animated image file (e.g., 'animation.gif')."
    )
    parser.add_argument(
        "--ms",
        help=f"The delay in ms between frames (at least 60). Default: {DEFAULT_ANIMATION_DELAY_MS}",
        default=DEFAULT_ANIMATION_DELAY_MS,
        type=int
    )
    parser.add_argument(
        "--time-only",
        help="Set the clock only.",
        action="store_true"
    )
    parser.add_argument(
        "--reset",
        help="Reset keyboard config to default values.",
        action="store_true"
    )
    parser.add_argument(
        "-v", "--verbose",
        help="Enable verbose output.",
        action="store_true"
    )
    args = parser.parse_args()

    if not args.reset and not args.time_only and (not args.first or not args.second):
        parser.error("The 'first' and 'second' arguments are required unless --reset or --time-only is used.")

    try:
        if args.verbose:
            print("Connecting to keyboard...")
        keyboard = Keyboard(usb_device=USBDevice())
    except (ValueError, IOError) as e:
        print(f"Error connecting to keyboard: {e}", file=sys.stderr)
        sys.exit(1)

    if args.reset:
        keyboard.reset()
        keyboard.close()
        sys.exit(0)

    if args.time_only:
        keyboard.set_datetime()
        keyboard.update_config()
        keyboard.close()
        sys.exit(0)

    try:
        if args.verbose:
            print(f"Processing first image: {args.first}")
        first = Animation(args.first)
        if args.verbose:
            print(f"Processing second image: {args.second}")
        second = Animation(args.second)
    except (FileNotFoundError, ValueError) as e:
        print(f"Error processing images: {e}", file=sys.stderr)
        sys.exit(1)

    if first.num_frames() + second.num_frames() > 90:
        print(f"Too many frames: {first.num_frames() + second.num_frames()} (max 90)")
        sys.exit(1)

    if args.verbose:
        print("Setting configuration...")
    keyboard.set_datetime()
    keyboard.set_animation_delay(args.ms)
    keyboard.set_frame_count(first.num_frames(), second.num_frames())
    keyboard.update_config()

    keyboard.upload_frames(first, second, args.verbose)

    keyboard.close()
    if args.verbose:
        print("Done.")

if __name__ == "__main__":
    main()
