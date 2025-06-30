from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="qdrant-mcp-server",
    version="1.0.0",
    author="KinDash Team",
    author_email="support@kindash.app",
    description="MCP server for semantic code search using Qdrant vector database",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/kindash/qdrant-mcp-server",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
    python_requires=">=3.8",
    install_requires=[
        "openai>=1.0.0",
        "qdrant-client>=1.7.0",
        "tiktoken>=0.5.0",
        "python-dotenv>=1.0.0",
        "click>=8.0.0",
        "rich>=13.0.0",
        "pathspec>=0.11.0",
    ],
    entry_points={
        "console_scripts": [
            "qdrant-mcp=mcp_qdrant_openai_wrapper:main",
            "qdrant-indexer=qdrant_openai_indexer:main",
        ],
    },
    include_package_data=True,
)