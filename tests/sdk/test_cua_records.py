"""Portable checks for the fixed SDK's generated record shape."""

import base64
from dataclasses import dataclass, fields
from types import SimpleNamespace

import pytest

from abridge.cua_driver import MAX_IMAGE_BYTES, CuaError, _add_image, _project


def test_generated_records_without_dataclass_fields_preserve_nested_public_data():
    bounds = GeneratedBounds(x=10, y=20, width=640, height=560)
    element = GeneratedElement(element_token="s00000001:1", label="输入中文", frame=bounds)
    record = GeneratedState(
        pid=44,
        window_id=99,
        title="测试窗口",
        bounds=bounds,
        elements=[element],
        launch_path="/private/not-for-agent",
        screenshot_file_path="/private/not-for-agent.png",
    )
    record.unadvertised = "must not be projected"
    assert fields(record) == ()
    projected = _project(record)
    assert projected == {
        "pid": 44,
        "window_id": 99,
        "title": "测试窗口",
        "bounds": {"x": 10, "y": 20, "width": 640, "height": 560},
        "elements": [
            {
                "element_token": "s00000001:1",
                "label": "输入中文",
                "frame": {"x": 10, "y": 20, "width": 640, "height": 560},
            }
        ],
    }


def test_unknown_objects_are_still_refused_instead_of_exporting_instance_attributes():
    with pytest.raises(CuaError) as caught:
        _project({"value": SimpleNamespace(secret="must not be projected")})
    assert caught.value.code == "cua_response_contract"


def test_record_projection_does_not_weaken_image_size_limit():
    image = SimpleNamespace(
        data_base64=base64.b64encode(b"x" * (MAX_IMAGE_BYTES + 1)).decode(), mime_type="image/png"
    )
    with pytest.raises(CuaError) as caught:
        _add_image({}, [image])
    assert caught.value.code == "cua_image_too_large"


@dataclass
class GeneratedBounds:
    __module__ = "cua_driver._native_contract"

    def __init__(self, *, x, y, width, height):
        self.x = x
        self.y = y
        self.width = width
        self.height = height


@dataclass
class GeneratedElement:
    __module__ = "cua_driver._native_contract"

    def __init__(self, *, element_token, label, frame):
        self.element_token = element_token
        self.label = label
        self.frame = frame


@dataclass
class GeneratedState:
    __module__ = "cua_driver._native_contract"

    def __init__(self, *, pid, window_id, title, bounds, elements, launch_path, screenshot_file_path):
        self.pid = pid
        self.window_id = window_id
        self.title = title
        self.bounds = bounds
        self.elements = elements
        self.launch_path = launch_path
        self.screenshot_file_path = screenshot_file_path
