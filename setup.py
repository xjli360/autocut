from setuptools import setup, find_packages

# openai-whisper moved to the optional "whisper" extra: its sdist no longer
# builds on setuptools>=81 (pkg_resources removed) and this fork defaults to
# FunASR Paraformer anyway.
requirements = [
    "ffmpeg-python",
    "moviepy<2",
    "opencc-python-reimplemented",
    "parameterized",
    "pydub",
    "srt",
    "torchaudio",
    "tqdm",
]


setup(
    name="autocut-sub",
    install_requires=requirements,
    url="https://github.com/mli/autocut",
    project_urls={
        "source": "https://github.com/mli/autocut",
    },
    license="Apache License 2.0",
    long_description=open("README.md", "r", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    extras_require={
        "all": ["openai", "faster-whisper", "openai-whisper"],
        "openai": ["openai"],
        "faster": ["faster-whisper"],
        "whisper": ["openai-whisper"],
        "funasr": ["funasr>=1.1.4", "modelscope", "torch"],
        "studio": [
            "funasr>=1.1.4",
            "modelscope",
            "torch",
            "fastapi",
            "uvicorn",
            "pillow",
        ],
    },
    packages=find_packages(),
    include_package_data=True,
    package_data={"autocut": ["studio/static/*"]},
    entry_points={
        "console_scripts": [
            "autocut = autocut.main:main",
        ]
    },
)
