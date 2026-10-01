namespace LiveRecorderDesktop;

internal sealed class ExitConfirmationDialog : Form
{
    internal ExitConfirmationDialog()
    {
        Text = "退出"; Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(255, 247, 248); ForeColor = Color.FromArgb(74, 36, 50);
        AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(420, 155);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent; ShowInTaskbar = false;
        Controls.Add(new Label { Text = "当前有任务正在进行中，退出可能会导致中断，是否继续", Location = new Point(24, 24), Size = new Size(372, 54) });
        var cancel = new Button { Name = "cancel", Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(172, 98), Size = new Size(108, 34) };
        var confirm = new Button { Name = "confirm", Text = "确认", DialogResult = DialogResult.OK, Location = new Point(288, 98), Size = new Size(108, 34) };
        foreach (var button in new[] { cancel, confirm })
        {
            button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderColor = Color.FromArgb(238, 184, 195);
            button.BackColor = button == confirm ? Color.FromArgb(255, 176, 190) : Color.White; button.UseVisualStyleBackColor = false;
            Controls.Add(button);
        }
        AcceptButton = cancel; CancelButton = cancel;
        Shown += (_, _) => cancel.Focus();
    }
}
