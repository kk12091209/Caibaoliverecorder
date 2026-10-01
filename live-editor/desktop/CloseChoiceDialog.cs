namespace LiveRecorderDesktop;

internal sealed class CloseChoiceDialog : Form
{
    private readonly CheckBox remember = new() { Name = "remember", Text = "不再提示", AutoSize = true, Location = new Point(24, 50) };
    internal string SelectedAction { get; private set; } = "";
    internal bool RememberSelection => remember.Checked;

    internal CloseChoiceDialog()
    {
        Text = "关闭";
        Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(255, 247, 248); ForeColor = Color.FromArgb(74, 36, 50);
        AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(360, 150);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent; ShowInTaskbar = false;
        Controls.Add(new Label { Text = "选择关闭方式", AutoSize = true, Location = new Point(24, 20), Font = new Font(Font, FontStyle.Bold) });
        Controls.Add(remember);
        var exit = ActionButton("exit", "退出", new Point(104, 96), Color.White);
        var background = ActionButton("background", "后台运行", new Point(228, 96), Color.FromArgb(255, 176, 190));
        Controls.Add(exit); Controls.Add(background);
        AcceptButton = background;
        Shown += (_, _) => background.Focus();
    }

    private Button ActionButton(string action, string text, Point location, Color color)
    {
        var button = new Button { Name = action, Text = text, Location = location, Size = new Size(108, 34), BackColor = color, ForeColor = ForeColor, FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor = false };
        button.FlatAppearance.BorderColor = Color.FromArgb(238, 184, 195);
        button.Click += (_, _) => { SelectedAction = action; DialogResult = DialogResult.OK; Close(); };
        return button;
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == Keys.Escape) { DialogResult = DialogResult.Cancel; Close(); return true; }
        return base.ProcessCmdKey(ref message, keyData);
    }
}
